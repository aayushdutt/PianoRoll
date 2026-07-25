// Single-pass H.264 MP4 via WebCodecs + Mediabunny (MP4 mux), with an optional AAC
// audio track muxed from a pre-rendered AudioBuffer (see OfflineAudioRenderer).
// Audio is encoded up front before the video loop — simpler than coordinating
// two parallel encoders.
//
// Resilience: codec selection runs two probe passes (hardware-preferred, then
// software-preferred) and the export retries ONCE on a software plan when the
// hardware encoder dies mid-run. PostHog showed video_encode failures are
// concentrated on Linux/ChromeOS/iOS where the hardware probe passes but the
// encoder then errors at runtime — a single software retry rescues those.

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
  audioEncodeMs: number
  videoEncodeMs: number
  finalizeMs: number
  outputBytes: number
  framesEncoded: number
}

export interface ExportOptions {
  fps?: number
  duration: number
  bitrate?: number
  audio?: AudioBuffer
  mode?: ExportMode
  filename?: string
  onProgress?: ExportProgressCallback
  // Fired at the start of every encode attempt with the chosen codec plan, so
  // the caller can report WHICH encoder path failed if the export later throws.
  onPlan?: (info: ExportPlanInfo) => void
  // Fired when a mid-run encoder failure triggers the software retry.
  onFallback?: (info: { fromCodec: string; toCodec: string; errorName: string }) => void
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
const MAX_ENCODE_QUEUE = 20 // backpressure: yield when queue exceeds this
const PROGRESS_UPDATE_EVERY_N_FRAMES = 3

const AUDIO_CODEC_STRING = 'mp4a.40.2' // AAC-LC
const AUDIO_BITRATE = 192_000
// Chunk size in frames; wall duration follows `buffer.sampleRate` (offline render is 44.1 kHz).
const AUDIO_CHUNK_FRAMES = 4096 // e.g. ~93 ms at 44.1 kHz — good encoder cadence
// Progress contract: each stage reports `pct` in [0, 1] relative to that stage
// only. The UI owns mapping stages onto an overall bar (see ExportModal's
// stage windows) — the encoder just reports honest per-stage fractions.

export class VideoExporter {
  private cancelled = false
  private encoder: VideoEncoder | null = null
  private audioEncoder: AudioEncoder | null = null

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

    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]!
      opts.onPlan?.({
        codec: plan.label,
        codecString: plan.codecString,
        hw: plan.hw,
        attempt: i + 1,
      })
      try {
        return await this.runAttempt(opts, plan, { fps, bitrate, width, height, attempt: i + 1 })
      } catch (err) {
        const isCancel = err instanceof DOMException && err.name === 'AbortError'
        const next = plans[i + 1]
        if (isCancel || !next) throw err
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

  // One complete mux+encode pass with a fixed codec plan. Retries re-enter with
  // a fresh Output/muxer, so audio is re-encoded too — sub-second work compared
  // to the minutes-long video pass it protects.
  private async runAttempt(
    opts: ExportOptions,
    plan: CodecPlan,
    cfg: { fps: number; bitrate: number; width: number; height: number; attempt: number },
  ): Promise<ExportStats> {
    const { fps, bitrate, width, height } = cfg
    const mode: ExportMode = opts.mode ?? 'av'
    const dt = 1 / fps
    const totalFrames = Math.max(1, Math.ceil(opts.duration * fps))

    const includeAudio = mode === 'av' && !!opts.audio
    const audio = includeAudio ? opts.audio! : null

    const bufferTarget = new BufferTarget()
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: bufferTarget,
    })
    const videoSource = new EncodedVideoPacketSource(plan.muxerCodec)
    output.addVideoTrack(videoSource, { frameRate: fps })

    let audioSource: EncodedAudioPacketSource | null = null
    if (audio) {
      audioSource = new EncodedAudioPacketSource('aac')
      output.addAudioTrack(audioSource)
    }

    await output.start()

    // Encode audio up-front. It's typically < 1s of work for a multi-minute
    // MIDI and gives the muxer all audio chunks before video starts streaming.
    let audioEncodeMs = 0
    if (audio && audioSource) {
      const audioStart = performance.now()
      await this.encodeAudio(audio, audioSource, opts.onProgress)
      audioSource.close()
      audioEncodeMs = performance.now() - audioStart
      this.throwIfStopped(null)
    }

    // The video encoder error callback fires asynchronously. Capture the first
    // error so the frame loop can surface it on the next cancellation/error check.
    // Mediabunny's track `add()` is async (backpressure); chain so chunks stay ordered.
    let encoderError: Error | null = null
    let videoMuxDrain = Promise.resolve()
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        videoMuxDrain = videoMuxDrain.then(() =>
          videoSource.add(EncodedPacket.fromEncodedChunk(chunk), meta),
        )
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

    try {
      for (let i = 0; i < totalFrames; i++) {
        this.throwIfStopped(encoderError)

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

        // Backpressure: if the encoder is falling behind, wait rather than
        // blowing up memory with pending VideoFrames.
        if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
          while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE / 2) {
            this.throwIfStopped(encoderError)
            await yieldTask()
          }
        } else if (i % 10 === 9) {
          // Even when the encoder keeps up, periodically yield so the browser
          // can run event loop tasks and the UI stays responsive. Uses
          // scheduler.yield() where available (Chrome 129+) which returns
          // ~immediately — setTimeout(0) has a hardcoded ~4 ms floor that
          // adds up to hundreds of ms over a typical export.
          await yieldToEventLoop()
        }
      }

      this.throwIfStopped(encoderError)

      opts.onProgress?.('Finalizing', 0)
      await encoder.flush()
      this.throwIfStopped(encoderError)
      await videoMuxDrain
      this.throwIfStopped(encoderError)
      videoSource.close()
      const videoEncodeMs = performance.now() - videoStart

      const finalizeStart = performance.now()
      opts.onProgress?.('Finalizing', 1)
      await output.finalize()
      const finalizeMs = performance.now() - finalizeStart

      opts.onProgress?.('Saving', 0)
      const buffer = bufferTarget.buffer
      if (!buffer) throw new Error('Export produced no file buffer')
      const blob = new Blob([buffer], { type: 'video/mp4' })
      triggerDownload(URL.createObjectURL(blob), opts.filename ?? 'midee.mp4')
      opts.onProgress?.('Saving', 1)
      opts.onProgress?.('Done', 1)

      return {
        codec: plan.label,
        codecString: plan.codecString,
        hw: plan.hw,
        attempts: cfg.attempt,
        audioEncodeMs: Math.round(audioEncodeMs),
        videoEncodeMs: Math.round(videoEncodeMs),
        finalizeMs: Math.round(finalizeMs),
        outputBytes: buffer.byteLength,
        framesEncoded: totalFrames,
      }
    } finally {
      if (encoder.state !== 'closed') encoder.close()
      this.encoder = null
    }
  }

  private async encodeAudio(
    audio: AudioBuffer,
    audioSource: EncodedAudioPacketSource,
    onProgress: ExportProgressCallback | undefined,
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
        audioMuxDrain = audioMuxDrain.then(() =>
          audioSource.add(EncodedPacket.fromEncodedChunk(chunk), meta),
        )
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

        onProgress?.('Encoding audio', offset / totalFrames)

        if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
          while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE / 2) {
            if (this.cancelled) throw new DOMException('Export cancelled', 'AbortError')
            await yieldTask()
          }
        }
      }

      await encoder.flush()
      if (encoderError) throw encoderError
      await audioMuxDrain
      onProgress?.('Encoding audio', 1)
    } finally {
      if (encoder.state !== 'closed') encoder.close()
      this.audioEncoder = null
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

function yieldTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
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
