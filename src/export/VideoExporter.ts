// VideoExporter — fast frame capture via MediaRecorder → MP4 via ffmpeg.wasm
//
// Speed strategy:
//   - canvas.captureStream(0) + requestFrame(): frames submitted manually,
//     browser VP9/VP8 encoder runs in a background thread (no main-thread cost per frame)
//   - setTimeout(0) yield: ~0.1ms per frame vs requestAnimationFrame's ~16ms
//
// Timing fix:
//   - Capture is faster than real-time, so WebM timestamps are wrong (all frames
//     land in a few wall-clock seconds). Fixed in ffmpeg with `-r fps` before `-i`,
//     which overrides the input timestamps and treats every N frames as 1 second.
//
// Audio:
//   - Not captured. The synth runs in an AudioContext that isn't connected to the
//     canvas stream. Adding audio requires an OfflineAudioContext render pass —
//     that's a future feature.

export type ExportProgressCallback = (stage: string, pct: number) => void

// Keep this aligned with the CORE_VERSION baked into the installed
// `@ffmpeg/ffmpeg` package. Mixing core versions can lead to decode/encode
// failures that only surface as empty output files.
const FFMPEG_CDN_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.9/dist/umd'

export class VideoExporter {
  private _cancelled = false
  private _ffmpeg: FFmpegHandle | null = null

  constructor(private canvas: HTMLCanvasElement) {}

  /** Abort an in-progress export. Safe to call at any point. */
  cancel(): void {
    this._cancelled = true
    this._ffmpeg?.terminate()
  }

  async export(opts: {
    fps?: number
    duration: number
    onProgress?: ExportProgressCallback
    onRenderFrame: (time: number, dt: number) => void
    onSeek: (time: number) => void
  }): Promise<void> {
    const fps = opts.fps ?? 30
    const { duration, onProgress, onRenderFrame, onSeek } = opts
    const totalFrames = Math.ceil(duration * fps)
    const dt = 1 / fps
    let ffmpeg: FFmpegHandle | null = null
    let phase: 'capture' | 'load' | 'encode' = 'capture'
    const ffmpegLogs: string[] = []

    // ── Phase 1: capture ─────────────────────────────────────────────────
    const stream = (this.canvas as CapturableCanvas).captureStream(0)
    const videoTrack = stream.getVideoTracks()[0] as VideoStreamTrack | undefined
    if (!videoTrack) throw new Error('captureStream() returned no video track')

    const mimeType = getSupportedMimeType()
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 })
    const chunks: Blob[] = []
    let recorderError: Error | null = null
    const recorderStopped = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => {
        if (recorderError) reject(recorderError)
        else resolve()
      }
      recorder.onerror = (event) => {
        recorderError = event.error ?? new Error('MediaRecorder failed during export')
      }
    })
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
    recorder.start()
    await yieldTask()

    try {
      for (let i = 0; i <= totalFrames; i++) {
        if (this._cancelled) throw new DOMException('Export cancelled', 'AbortError')
        const t = i * dt
        onSeek(t)
        onRenderFrame(t, dt)
        videoTrack.requestFrame()
        onProgress?.('Capturing', (i / totalFrames) * 0.55)
        await yieldTask()
      }

      if (recorder.state === 'recording') {
        recorder.requestData()
        await yieldTask()
        recorder.stop()
      }
      await recorderStopped
      if (this._cancelled) throw new DOMException('Export cancelled', 'AbortError')

      const capturedBytes = chunks.reduce((sum, chunk) => sum + chunk.size, 0)
      if (capturedBytes === 0) {
        throw new Error(
          'The browser recorder produced an empty WebM stream. No frames were flushed before encoding.',
        )
      }

      onProgress?.('Encoding', 0.55)

      // ── Phase 2: load ffmpeg ────────────────────────────────────────────
      phase = 'load'
      const { FFmpeg } = await import('@ffmpeg/ffmpeg')
      const { toBlobURL } = await import('@ffmpeg/util')
      const ffmpegInstance = new FFmpeg() as unknown as FFmpegHandle
      ffmpeg = ffmpegInstance

      ffmpegInstance.on('log', ({ message }: { message: string }) => {
        ffmpegLogs.push(message)
        if (ffmpegLogs.length > 50) ffmpegLogs.shift()
      })
      ffmpegInstance.on('progress', ({ progress }: { progress: number }) => {
        onProgress?.('Encoding', 0.55 + progress * 0.43)
      })

      this._ffmpeg = ffmpegInstance
      await ffmpegInstance.load({
        coreURL: await toBlobURL(`${FFMPEG_CDN_BASE}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${FFMPEG_CDN_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      })

      // ── Phase 3: encode ─────────────────────────────────────────────────
      phase = 'encode'
      const webmBytes = new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer())
      await ffmpegInstance.writeFile('input.webm', webmBytes)

      // -r fps BEFORE -i: overrides the wrong wall-clock timestamps in the WebM.
      // ffmpeg treats the N captured frames as playing at `fps`, giving the correct duration.
      // -preset ultrafast: fast wasm encode, file is slightly larger but that's fine here.
      const exitCode = await ffmpegInstance.exec([
        '-r', String(fps),
        '-i', 'input.webm',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'ultrafast',
        '-crf', '20',
        'output.mp4',
      ])
      if (exitCode !== 0) {
        throw new Error(`ffmpeg exited with code ${exitCode}. ${summarizeFfmpegLogs(ffmpegLogs)}`)
      }

      onProgress?.('Saving', 0.99)

      const out = await ffmpegInstance.readFile('output.mp4')
      if (!(out instanceof Uint8Array)) throw new Error('Unexpected output type from ffmpeg')
      if (out.byteLength === 0) {
        throw new Error(`ffmpeg produced an empty MP4 file. ${summarizeFfmpegLogs(ffmpegLogs)}`)
      }

      const mp4Bytes = out.slice().buffer as ArrayBuffer
      const blob = new Blob([mp4Bytes], { type: 'video/mp4' })
      triggerDownload(URL.createObjectURL(blob), 'pianoroll.mp4')
      onProgress?.('Done', 1)
    } catch (err) {
      if (this._cancelled) throw new DOMException('Export cancelled', 'AbortError')
      if (phase === 'load') {
        throw new Error(
          'Could not load the video encoder — check your internet connection and try again.',
          { cause: err },
        )
      }
      throw err
    } finally {
      this._ffmpeg = null
      ffmpeg?.terminate()
      stream.getTracks().forEach(track => track.stop())
    }
  }
}

function getSupportedMimeType(): string {
  for (const t of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  return 'video/webm'
}

function yieldTask(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

// captureStream() is widely supported but missing from lib.dom.d.ts
interface CapturableCanvas extends HTMLCanvasElement {
  captureStream(frameRate?: number): MediaStream
}

// requestFrame() is part of the MediaStreamTrack API for canvas streams,
// also missing from lib.dom.d.ts
interface VideoStreamTrack extends MediaStreamTrack {
  requestFrame(): void
}

interface FFmpegHandle {
  on(event: 'log', callback: (event: { message: string }) => void): void
  on(event: 'progress', callback: (event: { progress: number }) => void): void
  load(options: { coreURL: string; wasmURL: string }): Promise<unknown>
  writeFile(path: string, data: Uint8Array): Promise<unknown>
  exec(args: string[]): Promise<number>
  readFile(path: string): Promise<Uint8Array | string>
  terminate(): void
}

function summarizeFfmpegLogs(logs: string[]): string {
  const lastLine = [...logs].reverse().find((line) => line.trim().length > 0)
  return lastLine ? `Last ffmpeg log: ${lastLine}` : 'ffmpeg did not emit any diagnostic logs.'
}
