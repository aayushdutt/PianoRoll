// Single-pass H.264 MP4 via WebCodecs + Mediabunny (MP4 mux), with an optional AAC
// audio track. The audio is rendered (OfflineAudioRenderer, run by the caller
// through `ExportOptions.audio`) and encoded CONCURRENTLY with the video loop:
// the offline render happens on Chrome's audio thread and the video encoder in
// the codec process, so overlapping them costs no extra CPU and the wall time
// becomes max(audio, video) instead of the sum.
//
// Output is muxed into memory with `fastStart: 'reserve'` (the moov is
// reserved up front, so the file is held once, not assembled twice) and
// handed to the browser as a normal download — the downloads UI is the one
// place a user can open or reveal the file, which the File System Access
// path could not offer.
//
// Resilience: codec selection runs two probe passes (hardware-preferred, then
// software-preferred) and the export retries ONCE on a software plan when the
// hardware encoder dies mid-run. PostHog showed video_encode failures are
// concentrated on Linux/ChromeOS/iOS where the hardware probe passes but the
// encoder then errors at runtime — a single software retry rescues those.
// If the audio render fails the attempt is re-run without an audio track (an
// MP4 with an empty audio track is not something every player tolerates).

import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny'

export type ExportStage =
  | 'Rendering audio'
  | 'Encoding audio'
  | 'Encoding'
  | 'Finalizing'
  | 'Saving'
  | 'Done'
export type ExportProgressCallback = (stage: ExportStage, pct: number) => void

export type ExportMode = 'av' | 'video-only' | 'audio-only'

export type HwPreference = 'prefer-hardware' | 'prefer-software'

export interface ExportPlanInfo {
  codec: string // human label, e.g. 'H.264 High 4.0'
  codecString: string
  hw: HwPreference
  attempt: number // 1-based
}

// Returned on success so the caller can attach real numbers to telemetry -
// failures were previously the only instrumented outcome with any detail.
export interface ExportStats {
  codec: string
  codecString: string
  hw: HwPreference
  attempts: number
  audioIncluded: boolean
  audioRenderMs: number // 0 when the caller passed a pre-rendered buffer
  audioEncodeMs: number
  videoEncodeMs: number
  finalizeMs: number
  outputBytes: number
  framesEncoded: number
}

// Produces the audio to mux. Called once, right after the muxer starts, so the
// offline render overlaps the video loop. `report` carries render progress in
// [0, 1]; the exporter decides whether it is shown (it is hidden while the
// video loop is the thing the user is waiting on). Resolve `null` for "no
// audio"; a rejection is treated the same way after `onAudioUnavailable`.
export type AudioProducer = (report: (pct: number) => void) => Promise<AudioBuffer | null>

export interface ExportOptions {
  fps?: number
  duration: number
  bitrate?: number
  audio?: AudioBuffer | AudioProducer
  mode?: ExportMode
  filename?: string
  onProgress?: ExportProgressCallback
  // Fired at the start of every encode attempt with the chosen codec plan, so
  // the caller can report WHICH encoder path failed if the export later throws.
  onPlan?: (info: ExportPlanInfo) => void
  // Fired when a mid-run encoder failure triggers the software retry.
  onFallback?: (info: { fromCodec: string; toCodec: string; errorName: string }) => void
  // The audio producer failed; the export continues without sound.
  onAudioUnavailable?: (err: unknown) => void
  onRenderFrame: (time: number, dt: number) => void
  onSeek: (time: number) => void
}

interface CodecPlan {
  codecString: string // e.g. 'avc1.640028'
  muxerCodec: 'avc' | 'hevc' | 'vp9' | 'av1'
  label: string
  hw: HwPreference
}

const DEFAULT_FPS = 30
const DEFAULT_BITRATE = 8_000_000
const KEYFRAME_INTERVAL_SEC = 2
const MAX_ENCODE_QUEUE = 20 // backpressure: wait when queue exceeds this
const PROGRESS_UPDATE_EVERY_N_FRAMES = 3

const AUDIO_CODEC_STRING = 'mp4a.40.2' // AAC-LC
const AUDIO_BITRATE = 192_000
// Chunk size in frames; wall duration follows `buffer.sampleRate` (offline render is 44.1 kHz).
const AUDIO_CHUNK_FRAMES = 4096 // e.g. ~93 ms at 44.1 kHz — good encoder cadence
const AAC_FRAME_SAMPLES = 1024
// Upper bound on the audio sample rate the offline renderer might hand us,
// for sizing the reserved moov before the buffer exists.
const MAX_AUDIO_SAMPLE_RATE = 48_000
// Progress contract: each stage reports `pct` in [0, 1] relative to that stage
// only. The UI owns mapping stages onto an overall bar (see ExportModal's
// stage windows) — the encoder just reports honest per-stage fractions.

// Thrown inside an attempt when the audio producer came back empty after the
// audio track was already declared; the attempt is re-run without audio.
class AudioUnavailableError extends Error {
  constructor() {
    super('Audio unavailable')
    this.name = 'AudioUnavailableError'
  }
}

// An error after the video encode finished (finalize/save). Not an encoder
// fault, so the codec-plan fallback must NOT re-encode the whole piece on
// the next plan; the caller gets the original error.
class PostEncodeError extends Error {
  constructor(readonly inner: unknown) {
    super('Export failed after encoding')
    this.name = 'PostEncodeError'
  }
}

export class VideoExporter {
  private cancelled = false
  private encoder: VideoEncoder | null = null
  private audioEncoder: AudioEncoder | null = null
  private output: Output | null = null
  // Memoised across attempts: the offline render runs once per export even if
  // the encoder plan falls back.
  private audioResult: Promise<AudioBuffer | null> | null = null
  private audioRenderMs = 0
  // Where audio-render progress goes. Swapped per attempt; null while the
  // video loop is running so the bar tracks the stage the user is waiting on.
  private audioReport: ((pct: number) => void) | null = null
  private lastAudioPct = 0

  constructor(private canvas: HTMLCanvasElement) {}

  cancel(): void {
    this.cancelled = true
    // Close the encoders eagerly so in-flight encode() calls surface as errors
    // rather than silently queueing more work after the abort.
    if (this.encoder && this.encoder.state !== 'closed') {
      this.encoder.close()
    }
    if (this.audioEncoder && this.audioEncoder.state !== 'closed') {
      this.audioEncoder.close()
    }
    void this.output?.cancel().catch(() => {})
  }

  async export(opts: ExportOptions): Promise<ExportStats> {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      throw new Error(
        'This browser does not support WebCodecs video export. ' +
          'Update to Chrome 94+, Safari 16.4+ or Firefox 130+.',
      )
    }

    const fps = opts.fps ?? DEFAULT_FPS
    const bitrate = opts.bitrate ?? DEFAULT_BITRATE

    // H.264 requires even dimensions (YUV 4:2:0 subsampling). Round the canvas
    // size down to the nearest even number and crop each frame via `visibleRect`
    // — costs at most one pixel on the right/bottom edge, never visible.
    const canvasW = this.canvas.width
    const canvasH = this.canvas.height
    if (canvasW < 2 || canvasH < 2) {
      throw new Error('Canvas is too small to export - resize the window and try again.')
    }
    const width = canvasW & ~1
    const height = canvasH & ~1

    const plans = await buildCodecPlans(width, height, fps, bitrate)

    const mode: ExportMode = opts.mode ?? 'av'
    let withAudio = mode === 'av' && opts.audio !== undefined
    let attempt = 0
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]!
      attempt++
      opts.onPlan?.({
        codec: plan.label,
        codecString: plan.codecString,
        hw: plan.hw,
        attempt,
      })
      try {
        return await this.runAttempt(opts, plan, {
          fps,
          bitrate,
          width,
          height,
          attempt,
          withAudio,
        })
      } catch (err) {
        const isCancel = err instanceof DOMException && err.name === 'AbortError'
        if (isCancel) throw err
        if (err instanceof PostEncodeError) throw err.inner
        if (err instanceof AudioUnavailableError) {
          // Same plan again, no audio track. The render result is memoised
          // (null), so this costs only the video pass.
          withAudio = false
          i--
          continue
        }
        const next = plans[i + 1]
        if (!next) throw err
        opts.onFallback?.({
          fromCodec: `${plan.label} (${plan.hw})`,
          toCodec: `${next.label} (${next.hw})`,
          errorName: err instanceof Error ? err.name : 'UnknownError',
        })
        console.warn(`Export attempt with ${plan.label} (${plan.hw}) failed; retrying`, err)
      }
    }
    // Unreachable: the loop either returns or rethrows on the last plan.
    throw new Error('Export failed on every codec plan')
  }

  // Starts (once) and returns the audio buffer. Producer failures resolve to
  // null so the export can continue without sound.
  private getAudio(opts: ExportOptions): Promise<AudioBuffer | null> {
    if (this.audioResult) return this.audioResult
    const src = opts.audio
    if (src === undefined) {
      this.audioResult = Promise.resolve(null)
    } else if (typeof src === 'function') {
      const started = performance.now()
      this.audioResult = src((pct) => {
        this.lastAudioPct = pct
        this.audioReport?.(pct)
      })
        .catch((err: unknown) => {
          console.error('Offline audio render failed:', err)
          opts.onAudioUnavailable?.(err)
          return null
        })
        .then((buf) => {
          this.audioRenderMs = performance.now() - started
          return buf
        })
    } else {
      this.audioResult = Promise.resolve(src)
    }
    return this.audioResult
  }

  // One complete mux+encode pass with a fixed codec plan. Retries re-enter with
  // a fresh Output/muxer; the audio render is reused, only its encode repeats
  // (sub-second work compared to the minutes-long video pass it protects).
  private async runAttempt(
    opts: ExportOptions,
    plan: CodecPlan,
    cfg: {
      fps: number
      bitrate: number
      width: number
      height: number
      attempt: number
      withAudio: boolean
    },
  ): Promise<ExportStats> {
    const { fps, bitrate, width, height, withAudio } = cfg
    const dt = 1 / fps
    const totalFrames = Math.max(1, Math.ceil(opts.duration * fps))

    const bufferTarget = new BufferTarget()
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'reserve' }),
      target: bufferTarget,
    })
    this.output = output
    const videoSource = new EncodedVideoPacketSource(plan.muxerCodec)
    output.addVideoTrack(videoSource, {
      frameRate: fps,
      maximumPacketCount: totalFrames + 8,
    })

    let audioSource: EncodedAudioPacketSource | null = null
    if (withAudio) {
      audioSource = new EncodedAudioPacketSource('aac')
      // The renderer pads a tail past `duration`; +33% is Mediabunny's own
      // guidance for an estimate, +64 covers encoder priming/flush packets.
      const maxAudioPackets =
        Math.ceil(((opts.duration + 4) * MAX_AUDIO_SAMPLE_RATE * 1.34) / AAC_FRAME_SAMPLES) + 64
      output.addAudioTrack(audioSource, { maximumPacketCount: maxAudioPackets })
    }

    await output.start()

    // Audio pipeline, concurrent with the video loop below. Its progress is
    // silenced while video runs (the bar follows the encode); if it is still
    // going when the video finishes, the loop's tail surfaces it.
    let videoDone = false
    let audioEncodeMs = 0
    let audioMissing = false
    this.audioReport = null
    const audioTask = !audioSource
      ? Promise.resolve()
      : this.getAudio(opts)
          .then(async (buffer) => {
            if (!buffer) {
              audioMissing = true
              return
            }
            if (this.cancelled) return
            const src = audioSource
            const t0 = performance.now()
            await this.encodeAudio(buffer, src, (pct) => {
              if (videoDone) opts.onProgress?.('Encoding audio', pct)
            })
            src.close()
            audioEncodeMs = performance.now() - t0
          })
          .catch((err: unknown) => {
            // An audio ENCODE failure (no AAC encoder, mux error) is not a
            // video-codec fault: degrade to a silent export on the same plan
            // instead of burning a full video pass on the fallback codec.
            if (this.cancelled) return
            console.error('Audio encode failed:', err)
            opts.onAudioUnavailable?.(err)
            audioMissing = true
          })

    // The video encoder error callback fires asynchronously. Capture the first
    // error so the frame loop can surface it on the next cancellation/error check.
    // Mediabunny's track `add()` is async (backpressure); chain so chunks stay ordered.
    let encoderError: Error | null = null
    let videoMuxDrain = Promise.resolve()
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        // Surface mux failures through check() rather than as an unobserved
        // rejection (a cancelled Output rejects any add() still queued).
        videoMuxDrain = videoMuxDrain
          .then(() => videoSource.add(EncodedPacket.fromEncodedChunk(chunk), meta))
          .catch((e: unknown) => {
            encoderError ??= e as Error
          })
      },
      error: (e) => {
        encoderError ??= e as Error
      },
    })
    this.encoder = encoder

    encoder.configure({
      codec: plan.codecString,
      width,
      height,
      bitrate,
      framerate: fps,
      hardwareAcceleration: plan.hw,
      // 'realtime' skips the slower rate-distortion optimization passes the
      // encoder otherwise runs in 'quality' mode — ~1.5-2× faster encode for
      // the same bitrate, at a slight quality drop that is imperceptible at
      // the bitrates we target (typically YouTube re-encodes anyway). This
      // setting is unrelated to live audio latency — it only governs the
      // H.264 encoder's internal search depth.
      latencyMode: 'realtime',
    })

    const keyEvery = Math.max(1, Math.round(fps * KEYFRAME_INTERVAL_SEC))
    const videoStart = performance.now()
    let finalized = false

    const check = (): void => {
      this.throwIfStopped(encoderError)
      if (audioMissing) throw new AudioUnavailableError()
    }

    try {
      for (let i = 0; i < totalFrames; i++) {
        check()

        const t = i * dt
        opts.onSeek(t)
        opts.onRenderFrame(t, dt)

        const frame = new VideoFrame(this.canvas, {
          timestamp: Math.round((i * 1_000_000) / fps),
          visibleRect: { x: 0, y: 0, width, height },
          displayWidth: width,
          displayHeight: height,
        })
        encoder.encode(frame, { keyFrame: i % keyEvery === 0 })
        frame.close()

        if (i % PROGRESS_UPDATE_EVERY_N_FRAMES === 0) {
          opts.onProgress?.('Encoding', i / totalFrames)
        }

        // Backpressure: wake on the encoder's own dequeue event instead of
        // polling — no timer floor, and the loop resumes the instant there is
        // room. Otherwise yield every few frames so the audio pipeline and the
        // browser's own tasks get a turn.
        if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
          while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE / 2) {
            check()
            await waitForDequeue(encoder)
          }
        } else if (i % 10 === 9) {
          await yieldToEventLoop()
        }
      }

      check()

      opts.onProgress?.('Finalizing', 0)
      await encoder.flush()
      check()
      await videoMuxDrain
      check()
      videoSource.close()
      const videoEncodeMs = performance.now() - videoStart

      // Video is done; if the audio is still rendering/encoding, show it.
      videoDone = true
      if (audioSource) {
        this.audioReport = (pct) => opts.onProgress?.('Rendering audio', pct)
        if (this.audioRenderMs === 0) opts.onProgress?.('Rendering audio', this.lastAudioPct)
        await audioTask
        this.audioReport = null
        check()
      }

      const finalizeStart = performance.now()
      opts.onProgress?.('Finalizing', 1)
      let outputBytes = 0
      let finalizeMs = 0
      try {
        await output.finalize()
        finalized = true
        finalizeMs = performance.now() - finalizeStart

        opts.onProgress?.('Saving', 0)
        const buffer = bufferTarget.buffer
        if (!buffer) throw new Error('Export produced no file buffer')
        outputBytes = buffer.byteLength
        const blob = new Blob([buffer], { type: 'video/mp4' })
        triggerDownload(URL.createObjectURL(blob), opts.filename ?? 'midee.mp4')
      } catch (err) {
        const isCancel = err instanceof DOMException && err.name === 'AbortError'
        throw isCancel ? err : new PostEncodeError(err)
      }
      opts.onProgress?.('Saving', 1)
      opts.onProgress?.('Done', 1)

      return {
        codec: plan.label,
        codecString: plan.codecString,
        hw: plan.hw,
        attempts: cfg.attempt,
        audioIncluded: withAudio,
        audioRenderMs: Math.round(this.audioRenderMs),
        audioEncodeMs: Math.round(audioEncodeMs),
        videoEncodeMs: Math.round(videoEncodeMs),
        finalizeMs: Math.round(finalizeMs),
        outputBytes,
        framesEncoded: totalFrames,
      }
    } finally {
      videoDone = true
      this.audioReport = null
      if (encoder.state !== 'closed') encoder.close()
      this.encoder = null
      this.output = null
      if (!finalized) {
        // Stop the attempt's audio encode before the next attempt starts its
        // own, then release the muxer.
        if (this.audioEncoder && this.audioEncoder.state !== 'closed') this.audioEncoder.close()
        await audioTask.catch(() => {})
        await output.cancel().catch(() => {})
      }
    }
  }

  private async encodeAudio(
    audio: AudioBuffer,
    audioSource: EncodedAudioPacketSource,
    onProgress: (pct: number) => void,
  ): Promise<void> {
    if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
      // Silently skip audio if the browser lacks AudioEncoder (very rare where
      // VideoEncoder is supported but AudioEncoder is not). Video still exports.
      console.warn('AudioEncoder unavailable - exporting without audio')
      return
    }

    let encoderError: Error | null = null
    let audioMuxDrain = Promise.resolve()
    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
        audioMuxDrain = audioMuxDrain
          .then(() => audioSource.add(EncodedPacket.fromEncodedChunk(chunk), meta))
          .catch((e: unknown) => {
            encoderError ??= e as Error
          })
      },
      error: (e) => {
        encoderError ??= e as Error
      },
    })
    this.audioEncoder = encoder

    encoder.configure({
      codec: AUDIO_CODEC_STRING,
      sampleRate: audio.sampleRate,
      numberOfChannels: audio.numberOfChannels,
      bitrate: AUDIO_BITRATE,
    })

    const channelCount = audio.numberOfChannels
    const sampleRate = audio.sampleRate
    const totalFrames = audio.length

    const channels: Float32Array[] = []
    for (let ch = 0; ch < channelCount; ch++) {
      channels.push(audio.getChannelData(ch))
    }

    // AudioData copies from the provided buffer, so we can reuse one pack
    // buffer across every chunk instead of allocating per-iteration.
    const packed = new Float32Array(AUDIO_CHUNK_FRAMES * channelCount)

    try {
      let chunkIndex = 0
      for (let offset = 0; offset < totalFrames; offset += AUDIO_CHUNK_FRAMES) {
        if (encoderError) throw encoderError
        if (this.cancelled) throw new DOMException('Export cancelled', 'AbortError')

        const frames = Math.min(AUDIO_CHUNK_FRAMES, totalFrames - offset)
        // f32-planar layout: [ch0 samples..., ch1 samples..., ...].
        for (let ch = 0; ch < channelCount; ch++) {
          packed.set(channels[ch]!.subarray(offset, offset + frames), ch * frames)
        }

        const data = new AudioData({
          format: 'f32-planar',
          sampleRate,
          numberOfFrames: frames,
          numberOfChannels: channelCount,
          timestamp: Math.round((offset * 1_000_000) / sampleRate),
          data: packed,
        })
        encoder.encode(data)
        data.close()

        onProgress(offset / totalFrames)

        if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
          while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE / 2) {
            if (this.cancelled) throw new DOMException('Export cancelled', 'AbortError')
            await waitForDequeue(encoder)
          }
        } else if (++chunkIndex % 16 === 0) {
          // This runs alongside the video loop on the same thread — give it
          // (and the browser) a turn between bursts of chunks.
          await yieldToEventLoop()
        }
      }

      await encoder.flush()
      if (encoderError) throw encoderError
      await audioMuxDrain
      onProgress(1)
    } finally {
      if (encoder.state !== 'closed') encoder.close()
      if (this.audioEncoder === encoder) this.audioEncoder = null
    }
  }

  private throwIfStopped(encoderError: Error | null): void {
    if (this.cancelled) throw new DOMException('Export cancelled', 'AbortError')
    if (encoderError) throw encoderError
  }
}

// H.264 profiles in descending quality order. Probed per hardware preference.
const H264_CANDIDATES = [
  // Highest level first so the browser's first accept gives us the broadest
  // frame-size + MB/s budget. 5.2 is required for 4K@60 (4K@30 fits in 5.1);
  // 5.1 covers 4K@30 and 2K@60; 5.0 covers 2K@30 and 1080p@60.
  { codecString: 'avc1.640034', label: 'H.264 High 5.2 (4K@60)' },
  { codecString: 'avc1.640033', label: 'H.264 High 5.1 (4K@30)' },
  { codecString: 'avc1.640032', label: 'H.264 High 5.0 (2K)' },
  { codecString: 'avc1.640028', label: 'H.264 High 4.0' },
  { codecString: 'avc1.4D001F', label: 'H.264 Main 3.1' },
  { codecString: 'avc1.42E01F', label: 'H.264 Baseline 3.1' },
] as const

async function probeCodec(
  hw: HwPreference,
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<CodecPlan | null> {
  for (const c of H264_CANDIDATES) {
    const res = await VideoEncoder.isConfigSupported({
      codec: c.codecString,
      width,
      height,
      bitrate,
      framerate: fps,
      hardwareAcceleration: hw,
    })
    if (res.supported) {
      return { codecString: c.codecString, muxerCodec: 'avc', label: c.label, hw }
    }
  }
  return null
}

// Ordered attempt plans: hardware-preferred first, software-preferred as the
// runtime-failure fallback. On machines with no usable hardware encoder
// (common on Linux / ChromeOS) the first probe returns null and the software
// plan becomes the primary — previously those users got a hard error.
async function buildCodecPlans(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<CodecPlan[]> {
  const hwPlan = await probeCodec('prefer-hardware', width, height, fps, bitrate)
  const swPlan = await probeCodec('prefer-software', width, height, fps, bitrate)

  // Even when both probes land on the same codec string the two plans differ
  // in `hardwareAcceleration`, which is exactly the knob the retry exists for.
  const plans: CodecPlan[] = []
  if (hwPlan) plans.push(hwPlan)
  if (swPlan) plans.push(swPlan)

  if (plans.length === 0) {
    throw new Error(
      'No supported H.264 profile was accepted by this browser for the current canvas size. ' +
        'Try a lower resolution or updating your browser.',
    )
  }
  return plans
}

// Resolves when the encoder takes something off its queue, or after a short
// timer in case the event is coalesced or never comes (closed encoder).
function waitForDequeue(encoder: VideoEncoder | AudioEncoder): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      encoder.removeEventListener('dequeue', done)
      resolve()
    }
    const timer = setTimeout(done, 50)
    encoder.addEventListener('dequeue', done)
  })
}

// Lower-overhead yield for the keep-alive path. `scheduler.yield()` resolves
// on the next event loop tick without the ~4 ms setTimeout-0 clamp. Falls
// back to setTimeout for browsers that don't support the scheduler API.
function yieldToEventLoop(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scheduler = (globalThis as any).scheduler
  if (scheduler && typeof scheduler.yield === 'function') {
    return scheduler.yield() as Promise<void>
  }
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
