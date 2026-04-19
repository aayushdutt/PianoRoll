// Single-pass H.264 MP4 via WebCodecs + mp4-muxer, with an optional AAC audio
// track muxed from a pre-rendered AudioBuffer (see OfflineAudioRenderer). The
// muxer interleaves by timestamp, so audio is encoded up front before the
// video loop — simpler than coordinating two parallel encoders.

import { ArrayBufferTarget, Muxer } from 'mp4-muxer'

export type ExportStage =
  | 'Rendering audio'
  | 'Encoding audio'
  | 'Encoding'
  | 'Finalizing'
  | 'Saving'
  | 'Done'
export type ExportProgressCallback = (stage: ExportStage, pct: number) => void

export type ExportMode = 'av' | 'video-only' | 'audio-only'

export interface ExportOptions {
  fps?: number
  duration: number
  bitrate?: number
  audio?: AudioBuffer
  mode?: ExportMode
  filename?: string
  onProgress?: ExportProgressCallback
  onRenderFrame: (time: number, dt: number) => void
  onSeek: (time: number) => void
}

interface CodecPlan {
  codecString: string // e.g. 'avc1.640028'
  muxerCodec: 'avc' | 'hevc' | 'vp9' | 'av1'
  label: string
}

const DEFAULT_FPS = 30
const DEFAULT_BITRATE = 8_000_000
const KEYFRAME_INTERVAL_SEC = 2
const MAX_ENCODE_QUEUE = 20 // backpressure: yield when queue exceeds this
const PROGRESS_UPDATE_EVERY_N_FRAMES = 3

const AUDIO_CODEC_STRING = 'mp4a.40.2' // AAC-LC
const AUDIO_BITRATE = 192_000
const AUDIO_CHUNK_FRAMES = 4096 // ~85 ms at 48kHz — good encoder cadence
// Video progress is mapped into this slice of the overall [0,1] progress bar.
// Any pre-video stages (audio encode) occupy [0, VIDEO_PROGRESS_START).
const VIDEO_PROGRESS_START = 0.05

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

  async export(opts: ExportOptions): Promise<void> {
    const mode: ExportMode = opts.mode ?? 'av'

    if (mode === 'audio-only') {
      return this.exportAudioOnly(opts)
    }

    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      throw new Error(
        'This browser does not support WebCodecs video export. ' +
          'Update to Chrome 94+, Safari 16.4+ or Firefox 130+.',
      )
    }

    const fps = opts.fps ?? DEFAULT_FPS
    const bitrate = opts.bitrate ?? DEFAULT_BITRATE
    const dt = 1 / fps
    const totalFrames = Math.max(1, Math.ceil(opts.duration * fps))

    // H.264 requires even dimensions (YUV 4:2:0 subsampling). Round the canvas
    // size down to the nearest even number and crop each frame via `visibleRect`
    // — costs at most one pixel on the right/bottom edge, never visible.
    const canvasW = this.canvas.width
    const canvasH = this.canvas.height
    if (canvasW < 2 || canvasH < 2) {
      throw new Error('Canvas is too small to export — resize the window and try again.')
    }
    const width = canvasW & ~1
    const height = canvasH & ~1

    const plan = await pickCodec(width, height, fps, bitrate)

    const includeAudio = mode === 'av' && !!opts.audio
    const audio = includeAudio ? opts.audio! : null
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: plan.muxerCodec, width, height, frameRate: fps },
      ...(audio
        ? {
            audio: {
              codec: 'aac',
              numberOfChannels: audio.numberOfChannels,
              sampleRate: audio.sampleRate,
            },
          }
        : {}),
      fastStart: 'in-memory',
    })

    // Encode audio up-front. It's typically < 1s of work for a multi-minute
    // MIDI and gives the muxer all audio chunks before video starts streaming.
    if (audio) {
      await this.encodeAudio(audio, muxer, opts.onProgress, VIDEO_PROGRESS_START)
      this.throwIfStopped(null)
    }

    // The video encoder error callback fires asynchronously. Capture the first
    // error so the frame loop can surface it on the next cancellation/error check.
    let encoderError: Error | null = null
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
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
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'quality',
    })

    const keyEvery = Math.max(1, Math.round(fps * KEYFRAME_INTERVAL_SEC))
    const videoSpan = 0.95 - VIDEO_PROGRESS_START

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
          const pct = VIDEO_PROGRESS_START + (i / totalFrames) * videoSpan
          opts.onProgress?.('Encoding', pct)
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
          // can run event loop tasks and the UI stays responsive.
          await yieldTask()
        }
      }

      this.throwIfStopped(encoderError)

      opts.onProgress?.('Finalizing', 0.96)
      await encoder.flush()
      this.throwIfStopped(encoderError)

      muxer.finalize()

      opts.onProgress?.('Saving', 0.99)
      const { buffer } = muxer.target
      const blob = new Blob([buffer], { type: 'video/mp4' })
      triggerDownload(URL.createObjectURL(blob), opts.filename ?? 'midee.mp4')
      opts.onProgress?.('Done', 1)
    } finally {
      if (encoder.state !== 'closed') encoder.close()
      this.encoder = null
    }
  }

  // Audio-only path: skip all video encoding and mux just the audio buffer
  // into an MP4 container. Output is .m4a (AAC-in-MP4, universally playable).
  private async exportAudioOnly(opts: ExportOptions): Promise<void> {
    const audio = opts.audio
    if (!audio) throw new Error('Audio-only export requires an audio buffer')

    if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
      throw new Error(
        'This browser does not support WebCodecs audio export. ' +
          'Update to a recent Chrome, Safari 17+, or Firefox 133+.',
      )
    }

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      audio: {
        codec: 'aac',
        numberOfChannels: audio.numberOfChannels,
        sampleRate: audio.sampleRate,
      },
      fastStart: 'in-memory',
    })

    // Audio encoding spans most of the progress bar in this mode since there
    // is no video pass — leave a small slice for finalize + save.
    await this.encodeAudio(audio, muxer, opts.onProgress, 0.95)
    this.throwIfStopped(null)

    opts.onProgress?.('Finalizing', 0.96)
    muxer.finalize()

    opts.onProgress?.('Saving', 0.99)
    const { buffer } = muxer.target
    const blob = new Blob([buffer], { type: 'audio/mp4' })
    triggerDownload(URL.createObjectURL(blob), opts.filename ?? 'midee.m4a')
    opts.onProgress?.('Done', 1)
  }

  private async encodeAudio(
    audio: AudioBuffer,
    muxer: Muxer<ArrayBufferTarget>,
    onProgress: ExportProgressCallback | undefined,
    progressScale: number,
  ): Promise<void> {
    if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
      // Silently skip audio if the browser lacks AudioEncoder (very rare where
      // VideoEncoder is supported but AudioEncoder is not). Video still exports.
      console.warn('AudioEncoder unavailable — exporting without audio')
      return
    }

    let encoderError: Error | null = null
    const encoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
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

        const pct = (offset / totalFrames) * progressScale
        onProgress?.('Encoding audio', pct)

        if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
          while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE / 2) {
            if (this.cancelled) throw new DOMException('Export cancelled', 'AbortError')
            await yieldTask()
          }
        }
      }

      await encoder.flush()
      if (encoderError) throw encoderError
      onProgress?.('Encoding audio', progressScale)
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

// Probes a short list of H.264 profiles in descending quality order. Returns
// the first one the browser will actually hardware-encode at the given size.
async function pickCodec(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<CodecPlan> {
  const candidates: CodecPlan[] = [
    { codecString: 'avc1.640028', muxerCodec: 'avc', label: 'H.264 High 4.0' },
    { codecString: 'avc1.4D001F', muxerCodec: 'avc', label: 'H.264 Main 3.1' },
    { codecString: 'avc1.42E01F', muxerCodec: 'avc', label: 'H.264 Baseline 3.1' },
  ]

  for (const c of candidates) {
    const res = await VideoEncoder.isConfigSupported({
      codec: c.codecString,
      width,
      height,
      bitrate,
      framerate: fps,
      hardwareAcceleration: 'prefer-hardware',
    })
    if (res.supported) return c
  }

  throw new Error(
    'No supported H.264 profile was accepted by this browser for the current canvas size. ' +
      'Try resizing the window or updating your browser.',
  )
}

function yieldTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
