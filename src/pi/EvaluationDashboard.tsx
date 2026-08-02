import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'
import { parseMidiFile } from '../core/midi/parser'
import type { MidiFile } from '../core/midi/types'
import { useApp } from '../store/AppCtx'
import type { AudioPerceptualResult } from './audioPerception'
import { EvaluationScore } from './EvaluationScore'
import {
  analyzeEvaluation,
  type EvaluationRun,
  estimateConstantOffset,
  flattenMidi,
  matchEvents,
  midiFromEvents,
  parseEvaluationRun,
  traceEvents,
} from './evaluation'
import type { EvaluationTraceMessage, LedMessage, PiStatusMessage, TimingMode } from './ledProtocol'

const LAST_RUN_STORAGE_KEY = 'midee.piEvaluation.lastRun'

interface TimelineErrorMarker {
  time: number
  magnitudeMs: number
  kind: 'timing' | 'early-release' | 'late-release' | 'missing' | 'extra' | 'drop'
}

interface LiveTelemetryPoint {
  time: number
  audioLevelDbfs: number
  computeMs: number
  slackMs: number
  eventCount: number
}

function saveLastRun(run: EvaluationRun): void {
  try {
    localStorage.setItem(LAST_RUN_STORAGE_KEY, JSON.stringify(run))
  } catch {
    // Export JSON remains available when storage is disabled or full.
  }
}

interface Props {
  connected: Accessor<boolean>
  message: Accessor<LedMessage | null>
  send: (message: object) => boolean
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function downloadJson(filename: string, value: unknown): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function downmix(buffer: AudioBuffer): Float32Array {
  const output = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const source = buffer.getChannelData(channel)
    for (let index = 0; index < output.length; index++) {
      output[index] = (output[index] ?? 0) + (source[index] ?? 0) / buffer.numberOfChannels
    }
  }
  return output
}

async function decodeSourceAudio(file: File): Promise<AudioBuffer> {
  const context = new AudioContext()
  try {
    return await context.decodeAudioData(await file.arrayBuffer())
  } finally {
    await context.close()
  }
}

function analyzeAudioInWorker(
  reference: AudioBuffer,
  reconstruction: AudioBuffer,
): Promise<AudioPerceptualResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./audioPerception.worker.ts', import.meta.url), {
      type: 'module',
    })
    const referencePcm = downmix(reference)
    const reconstructionPcm = downmix(reconstruction)
    worker.addEventListener('message', (event: MessageEvent<AudioPerceptualResult>) => {
      resolve(event.data)
      worker.terminate()
    })
    worker.addEventListener('error', (event) => {
      reject(new Error(event.message || 'Perceptual audio worker failed.'))
      worker.terminate()
    })
    worker.postMessage(
      {
        reference: referencePcm,
        reconstruction: reconstructionPcm,
        sampleRate: reference.sampleRate,
      },
      [referencePcm.buffer, reconstructionPcm.buffer],
    )
  })
}

function chartPath(
  points: readonly { time: number; value: number }[],
  width: number,
  height: number,
): string {
  if (!points.length) return ''
  const maxTime = Math.max(1, ...points.map((point) => point.time))
  const values = points.map((point) => point.value)
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const span = Math.max(1e-6, maxValue - minValue)
  return points
    .map((point, index) => {
      const x = (point.time / maxTime) * width
      const y = height - ((point.value - minValue) / span) * height
      return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

export function EvaluationDashboard(props: Props) {
  const { services } = useApp()
  const [midi, setMidi] = createSignal<MidiFile | null>(null)
  const [midiBytes, setMidiBytes] = createSignal<Uint8Array | null>(null)
  const [sourceAudioFile, setSourceAudioFile] = createSignal<File | null>(null)
  const [sourceAudioDuration, setSourceAudioDuration] = createSignal(0)
  const [sourcePairValid, setSourcePairValid] = createSignal(false)
  const [timingMode, setTimingMode] = createSignal<TimingMode>('adaptive')
  const [state, setState] = createSignal(
    'Load a ground-truth MIDI and its paired WAV/audio file.',
  )
  const [run, setRun] = createSignal<EvaluationRun | null>(null)
  const [compareRun, setCompareRun] = createSignal<EvaluationRun | null>(null)
  const [audioResult, setAudioResult] = createSignal<AudioPerceptualResult | null>(null)
  const [reconstructedMidi, setReconstructedMidi] = createSignal<MidiFile | null>(null)
  const [playbackTarget, setPlaybackTarget] = createSignal<'reference' | 'reconstructed'>(
    'reference',
  )
  const [playbackTime, setPlaybackTime] = createSignal(0)
  const [playbackRunning, setPlaybackRunning] = createSignal(false)
  const [progress, setProgress] = createSignal(0)
  const [workspaceOpen, setWorkspaceOpen] = createSignal(true)
  const [fullscreen, setFullscreen] = createSignal(false)
  const [activeView, setActiveView] = createSignal<'overview' | 'replay' | 'diagnostics'>(
    'overview',
  )
  const [isEvaluating, setIsEvaluating] = createSignal(false)
  const [piStatus, setPiStatus] = createSignal<PiStatusMessage | null>(null)
  const [liveTelemetry, setLiveTelemetry] = createSignal<LiveTelemetryPoint[]>([])
  let evaluationActive = false
  let maximumAudioLevelDbfs = -120
  let playbackFrame = 0
  let playbackStartedAt = 0
  let playbackStartedFrom = 0
  let startedResolve: ((id: string) => void) | null = null
  let stoppedResolve: (() => void) | null = null
  let traceResolve: ((records: EvaluationTraceMessage['records']) => void) | null = null
  let traceChunks: Array<EvaluationTraceMessage['records'] | undefined> = []
  let sourceAudio: HTMLAudioElement | null = null
  let sourceAudioUrl: string | null = null

  createEffect(() => {
    const message = props.message()
    if (!message) return
    if (message.type === 'status') {
      setPiStatus(message)
      if (evaluationActive) {
        setLiveTelemetry((points) => [
          ...points.slice(-119),
          {
            time: performance.now() / 1000,
            audioLevelDbfs: message.audioLevelDbfs ?? -120,
            computeMs: message.computeMs ?? 0,
            slackMs: message.slackMs ?? 0,
            eventCount: message.eventCount,
          },
        ])
      }
    }
    if (
      evaluationActive &&
      message.type === 'status' &&
      typeof message.audioLevelDbfs === 'number'
    ) {
      maximumAudioLevelDbfs = Math.max(maximumAudioLevelDbfs, message.audioLevelDbfs)
    } else if (message.type === 'evaluation_started') {
      startedResolve?.(message.sessionId)
      startedResolve = null
    } else if (message.type === 'evaluation_stopped') {
      stoppedResolve?.()
      stoppedResolve = null
    } else if (message.type === 'evaluation_trace') {
      traceChunks[message.chunkIndex] = message.records
      if (
        traceChunks.length >= message.chunkCount &&
        Array.from({ length: message.chunkCount }, (_, index) => traceChunks[index]).every(Boolean)
      ) {
        traceResolve?.(traceChunks.slice(0, message.chunkCount).flatMap((chunk) => chunk ?? []))
        traceResolve = null
      }
    }
  })

  const loadMidi = async (file: File): Promise<void> => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const parsed = await parseMidiFile(bytes.slice().buffer, file.name)
      setMidi(parsed)
      setMidiBytes(bytes)
      services.renderer.loadMidi(parsed)
      setState(
        `${parsed.name}: ${flattenMidi(parsed).length} notes, ${parsed.duration.toFixed(1)}s`,
      )
    } catch (error) {
      setState(error instanceof Error ? error.message : 'Unable to parse MIDI.')
    }
  }

  const loadSourceAudio = async (file: File): Promise<void> => {
    sourceAudio?.pause()
    if (sourceAudioUrl) URL.revokeObjectURL(sourceAudioUrl)
    sourceAudioUrl = URL.createObjectURL(file)
    const audio = new Audio(sourceAudioUrl)
    audio.preload = 'auto'
    await new Promise<void>((resolve, reject) => {
      audio.addEventListener('loadedmetadata', () => resolve(), { once: true })
      audio.addEventListener(
        'error',
        () => reject(new Error(`Unable to load source audio: ${file.name}`)),
        { once: true },
      )
      audio.load()
    })
    sourceAudio = audio
    setSourceAudioFile(file)
    setSourceAudioDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
    setState(
      `${file.name}: ${formatTimelineTime(audio.duration)} source audio loaded for playback.`,
    )
  }

  const loadEvaluationPair = async (files: FileList): Promise<void> => {
    const selected = Array.from(files)
    const midiFile = selected.find((file) => /\.(mid|midi)$/i.test(file.name))
    const audioFile = selected.find((file) => !/\.(mid|midi)$/i.test(file.name))
    if (selected.length < 1 || selected.length > 2 || (!midiFile && !audioFile)) {
      setSourcePairValid(false)
      setState('Select one MIDI, one WAV/audio file, or both matching files together.')
      return
    }
    setSourcePairValid(false)
    if (midiFile) await loadMidi(midiFile)
    if (audioFile) await loadSourceAudio(audioFile)
    const nextMidiName = midiFile?.name ?? midi()?.name
    const nextAudioName = audioFile?.name ?? sourceAudioFile()?.name
    if (!nextMidiName || !nextAudioName) {
      setState(
        midiFile
          ? 'Reference MIDI loaded. Use the same control again to choose its paired audio.'
          : 'Source audio loaded. Use the same control again to choose its paired MIDI.',
      )
      return
    }
    const stem = (name: string): string => name.replace(/\.[^.]+$/, '').toLowerCase()
    if (stem(nextMidiName) !== stem(nextAudioName)) {
      setState(
        `Pair mismatch: ${nextMidiName} and ${nextAudioName} must share the same basename.`,
      )
      return
    }
    setSourcePairValid(true)
    setState(
      `Paired source loaded: ${nextAudioName} · MIDI retained as ground truth only.`,
    )
  }

  const waitForStarted = (): Promise<string> =>
    new Promise((resolve, reject) => {
      startedResolve = resolve
      setTimeout(() => reject(new Error('Pi did not start the evaluation session.')), 5_000)
    })

  const waitForStopped = (): Promise<void> =>
    new Promise((resolve, reject) => {
      stoppedResolve = resolve
      setTimeout(() => reject(new Error('Pi did not stop the evaluation session.')), 5_000)
    })

  const getTrace = (): Promise<EvaluationTraceMessage['records']> =>
    new Promise((resolve, reject) => {
      traceChunks = []
      traceResolve = resolve
      if (!props.send({ type: 'evaluation', action: 'get' })) {
        reject(new Error('Pi WebSocket is disconnected.'))
      }
      setTimeout(() => reject(new Error('Timed out retrieving the Pi trace.')), 15_000)
    })

  const runEvaluation = async (): Promise<void> => {
    const reference = midi()
    const bytes = midiBytes()
    const audioFile = sourceAudioFile()
    const evaluationAudio = sourceAudio
    if (!reference || !bytes || !audioFile || !evaluationAudio) {
      setState('Load both the reference MIDI and paired source audio first.')
      return
    }
    if (!props.connected()) {
      setState('Connect to the Pi first.')
      return
    }
    try {
      setRun(null)
      setAudioResult(null)
      setReconstructedMidi(null)
      setProgress(0)
      setLiveTelemetry([])
      maximumAudioLevelDbfs = -120
      evaluationActive = true
      setIsEvaluating(true)
      setState(`Starting ${timingMode()} evaluation…`)
      const started = waitForStarted()
      if (!props.send({ type: 'evaluation', action: 'start', timingMode: timingMode() })) {
        throw new Error('Pi WebSocket is disconnected.')
      }
      // Start media while this call still has the Run button's user activation.
      // Waiting for the Pi acknowledgement first can make Chrome reject play()
      // for a local file because the transient activation has expired.
      evaluationAudio.currentTime = 0
      evaluationAudio.volume = 1
      await evaluationAudio.play()
      const id = await started
      const startedAt = performance.now()
      // Fixed mode deliberately adds 1.75 s of presentation buffer and both
      // modes include model lookahead/A2DP delay. Keep enough post-roll that the
      // final scheduled notes and releases arrive before trace stop.
      const postRollSeconds = timingMode() === 'fixed' ? 5 : 3
      const durationMs = (evaluationAudio.duration + postRollSeconds) * 1000
      while (performance.now() - startedAt < durationMs) {
        await wait(250)
        const elapsedMs = performance.now() - startedAt
        setProgress(Math.min(1, elapsedMs / durationMs))
        if (elapsedMs >= 5_000 && maximumAudioLevelDbfs <= -60) {
          throw new Error(
            'No audio reached the Pi. Choose CommieX in the Windows taskbar sound-output menu, then retry.',
          )
        }
      }
      evaluationAudio.pause()
      const stopped = waitForStopped()
      props.send({ type: 'evaluation', action: 'stop' })
      await stopped
      const trace = await getTrace()
      if (!trace.some((record) => record.stage === 'detected')) {
        throw new Error('Invalid run: the Pi trace contains no detected audio events.')
      }
      setState('Analyzing MIDI timing…')
      const metrics = analyzeEvaluation(reference, trace)
      const detected = traceEvents(trace, 'emitted')
      const offset = estimateConstantOffset(flattenMidi(reference), detected)
      const reconstructed = midiFromEvents(
        `${reference.name} reconstruction`,
        detected.map((event) => ({ ...event, time: Math.max(0, event.time - offset) })),
      )
      setReconstructedMidi(reconstructed)
      setState('Analyzing source audio against the reconstruction…')
      const { renderAudioOffline } = await import('../audio/OfflineAudioRenderer')
      const referenceAudio = await decodeSourceAudio(audioFile)
      const reconstructionAudio = await renderAudioOffline({
        midi: reconstructed,
        instrumentId: 'digital',
        volume: 0.8,
        sampleRate: referenceAudio.sampleRate,
      })
      const perceptual = await analyzeAudioInWorker(referenceAudio, reconstructionAudio)
      const completed: EvaluationRun = {
        schemaVersion: 2,
        id,
        createdAt: new Date().toISOString(),
        referenceName: reference.name,
        sourceAudioName: audioFile.name,
        referenceMidiBase64: bytesToBase64(bytes),
        timingMode: timingMode(),
        trace,
        metrics,
      }
      setAudioResult(perceptual)
      setRun(completed)
      saveLastRun(completed)
      setActiveView('overview')
      setProgress(1)
      setState(
        `${timingMode()} complete: ${(metrics.recall * 100).toFixed(1)}% recall, ${metrics.hiccups50} hiccups`,
      )
    } catch (error) {
      evaluationAudio?.pause()
      props.send({ type: 'evaluation', action: 'stop' })
      setState(error instanceof Error ? error.message : 'Evaluation failed.')
    } finally {
      evaluationActive = false
      setIsEvaluating(false)
    }
  }

  const playResult = async (target: 'reference' | 'reconstructed', fromTime = 0): Promise<void> => {
    const selected = target === 'reference' ? midi() : reconstructedMidi()
    if (!selected) return
    setPlaybackTarget(target)
    await services.synth.setInstrument('digital')
    services.synth.setSpeed(1)
    await services.synth.load(selected)
    await services.synth.play(Math.max(0, Math.min(fromTime, selected.duration)))
    cancelAnimationFrame(playbackFrame)
    playbackStartedFrom = Math.max(0, Math.min(fromTime, selected.duration))
    playbackStartedAt = performance.now()
    setPlaybackTime(playbackStartedFrom)
    setPlaybackRunning(true)
    const updateCursor = (): void => {
      const nextTime = playbackStartedFrom + (performance.now() - playbackStartedAt) / 1000
      if (nextTime >= selected.duration) {
        setPlaybackTime(selected.duration)
        setPlaybackRunning(false)
        return
      }
      setPlaybackTime(nextTime)
      playbackFrame = requestAnimationFrame(updateCursor)
    }
    playbackFrame = requestAnimationFrame(updateCursor)
    setState(
      `Playing ${target === 'reference' ? 'original MIDI' : 'reconstructed MIDI'} from ${fromTime.toFixed(2)}s`,
    )
  }

  const stopAudio = (): void => {
    sourceAudio?.pause()
    services.synth.pause()
    cancelAnimationFrame(playbackFrame)
    setPlaybackRunning(false)
    props.send({ type: 'evaluation', action: 'stop' })
    evaluationActive = false
    setIsEvaluating(false)
    setState('Audio stopped.')
  }

  const hydrateRun = async (savedRun: EvaluationRun): Promise<void> => {
    const bytes = base64ToBytes(savedRun.referenceMidiBase64)
    const reference = await parseMidiFile(bytes.slice().buffer, savedRun.referenceName)
    const emitted = traceEvents(savedRun.trace, 'emitted')
    const offset = estimateConstantOffset(flattenMidi(reference), emitted)
    setMidi(reference)
    setMidiBytes(bytes)
    setReconstructedMidi(
      midiFromEvents(
        `${reference.name} reconstruction`,
        emitted.map((event) => ({ ...event, time: Math.max(0, event.time - offset) })),
      ),
    )
    setRun(savedRun)
  }

  const lagPath = createMemo(() =>
    chartPath(
      run()?.metrics.timing.map((point) => ({ time: point.time, value: point.lagMs })) ?? [],
      800,
      150,
    ),
  )
  const tempoPath = createMemo(() =>
    chartPath(
      run()?.metrics.timing.map((point) => ({ time: point.time, value: point.tempoRatio })) ?? [],
      800,
      150,
    ),
  )
  const severityPath = createMemo(() =>
    chartPath(
      audioResult()?.frames.map((frame) => ({ time: frame.time, value: frame.severity })) ?? [],
      800,
      150,
    ),
  )
  const liveAudioPath = createMemo(() =>
    chartPath(
      liveTelemetry().map((point, index) => ({
        time: index,
        value: Math.max(-90, point.audioLevelDbfs),
      })),
      800,
      150,
    ),
  )
  const liveComputePath = createMemo(() =>
    chartPath(
      liveTelemetry().map((point, index) => ({ time: index, value: point.computeMs })),
      800,
      150,
    ),
  )
  const liveSlackPath = createMemo(() =>
    chartPath(
      liveTelemetry().map((point, index) => ({ time: index, value: point.slackMs })),
      800,
      150,
    ),
  )
  const errorMarkers = createMemo<TimelineErrorMarker[]>(() => {
    const reference = midi()
    const reconstruction = reconstructedMidi()
    if (!reference || !reconstruction) return []
    const alignment = matchEvents(flattenMidi(reference), flattenMidi(reconstruction), 0.25)
    const markers: TimelineErrorMarker[] = alignment.matches
      .filter((match) => Math.abs(match.error) >= 0.05)
      .map((match) => ({
        time: match.reference.time,
        magnitudeMs: Math.abs(match.error) * 1000,
        kind: 'timing',
      }))
    markers.push(
      ...alignment.matches
        .filter(
          (match) =>
            Math.abs(
              match.actual.time +
                match.actual.duration -
                (match.reference.time + match.reference.duration),
            ) >= 0.05,
        )
        .map((match) => {
          const error =
            match.actual.time +
            match.actual.duration -
            (match.reference.time + match.reference.duration)
          return {
            time: match.reference.time + match.reference.duration,
            magnitudeMs: Math.abs(error) * 1000,
            kind: error < 0 ? ('early-release' as const) : ('late-release' as const),
          }
        }),
    )
    markers.push(
      ...alignment.unmatchedReference.map((event) => ({
        time: event.time,
        magnitudeMs: 250,
        kind: 'missing' as const,
      })),
      ...alignment.unmatchedActual.map((event) => ({
        time: event.time,
        magnitudeMs: 250,
        kind: 'extra' as const,
      })),
      ...(run()
        ?.metrics.hiccups.filter((hiccup) => hiccup.kind === 'drop')
        .map((hiccup) => ({
          time: hiccup.time,
          magnitudeMs: hiccup.magnitudeMs,
          kind: 'drop' as const,
        })) ?? []),
    )
    return markers.sort((a, b) => a.time - b.time)
  })

  const importRun = async (file: File, comparison: boolean): Promise<void> => {
    try {
      const parsed = parseEvaluationRun(JSON.parse(await file.text()))
      if (!parsed) throw new Error('Unsupported or malformed evaluation bundle.')
      if (comparison) setCompareRun(parsed)
      else {
        await hydrateRun(parsed)
        saveLastRun(parsed)
      }
    } catch (error) {
      setState(error instanceof Error ? error.message : 'Unable to import evaluation.')
    }
  }

  onMount(() => {
    const saved = localStorage.getItem(LAST_RUN_STORAGE_KEY)
    if (!saved) return
    let parsed: EvaluationRun | null = null
    try {
      parsed = parseEvaluationRun(JSON.parse(saved))
    } catch {
      localStorage.removeItem(LAST_RUN_STORAGE_KEY)
    }
    if (!parsed) return
    void hydrateRun(parsed).then(() => {
      setState(`Restored ${parsed.referenceName}. Original and reconstructed replay are ready.`)
    })
  })

  onCleanup(() => {
    cancelAnimationFrame(playbackFrame)
    sourceAudio?.pause()
    if (sourceAudioUrl) URL.revokeObjectURL(sourceAudioUrl)
    services.synth.pause()
  })

  return (
    <Show
      when={workspaceOpen()}
      fallback={
        <button class="pi-eval-launcher" type="button" onClick={() => setWorkspaceOpen(true)}>
          <span>Reconstruction evaluation</span>
          <strong>
            {run() ? `${(run()!.metrics.recall * 100).toFixed(1)}% recall` : 'Open lab'}
          </strong>
        </button>
      }
    >
      <section
        class="pi-eval"
        classList={{ 'is-fullscreen': fullscreen() }}
        aria-label="MIDI reconstruction evaluation"
      >
        <header class="pi-eval__topbar">
          <div class="pi-eval__identity">
            <span class="pi-eval__eyebrow">Audio → MIDI validation</span>
            <h2>Reconstruction evaluation</h2>
          </div>
          <div class="pi-eval__health">
            <StatusChip
              label="Pi"
              value={props.connected() ? 'Connected' : 'Offline'}
              ok={props.connected()}
            />
            <StatusChip
              label="Input"
              value={
                typeof piStatus()?.audioLevelDbfs === 'number'
                  ? `${piStatus()!.audioLevelDbfs!.toFixed(0)} dBFS`
                  : 'Waiting'
              }
              ok={(piStatus()?.audioLevelDbfs ?? -120) > -60}
            />
            <StatusChip
              label="Trace"
              value={isEvaluating() ? 'Recording' : 'Idle'}
              ok={isEvaluating()}
            />
          </div>
          <div class="pi-eval__window-actions">
            <button
              type="button"
              aria-label={fullscreen() ? 'Exit fullscreen' : 'Open fullscreen'}
              onClick={() => setFullscreen((value) => !value)}
            >
              {fullscreen() ? 'Window' : 'Expand'}
            </button>
            <button
              type="button"
              aria-label="Collapse evaluation"
              onClick={() => setWorkspaceOpen(false)}
            >
              Collapse
            </button>
          </div>
        </header>

        <div class="pi-eval__workspace">
          <aside class="pi-eval__setup">
            <section>
              <span class="pi-eval__step">01 · Paired source</span>
              <label class="pi-eval__dropzone">
                <strong>
                  {sourceAudioFile()?.name ?? 'Choose paired WAV/audio + MIDI'}
                </strong>
                <span>
                  {midi() && sourceAudioFile()
                    ? `${flattenMidi(midi()!).length} reference notes · ${formatTimelineTime(sourceAudioDuration())} actual audio`
                    : 'Select exactly two matching files · audio plays, MIDI scores'}
                </span>
                <input
                  type="file"
                  accept="audio/*,.wav,.flac,.mp3,.m4a,.ogg,.mid,.midi"
                  multiple
                  onChange={(event) => {
                    const files = event.currentTarget.files
                    if (files) void loadEvaluationPair(files)
                  }}
                />
              </label>
            </section>

            <section>
              <span class="pi-eval__step">02 · Audio route</span>
              <div class="pi-eval__route">
                <span>Paired source audio</span>
                <i>→</i>
                <span>Windows</span>
                <i>→</i>
                <strong>Pi Bluetooth output</strong>
              </div>
              <p>Select the Pi Bluetooth endpoint in the Windows sound menu before starting.</p>
              <div
                class="pi-eval__meter"
                role="progressbar"
                aria-label="Pi input audio level"
                aria-valuemin="-90"
                aria-valuemax="0"
                aria-valuenow={Math.max(-90, piStatus()?.audioLevelDbfs ?? -120)}
              >
                <span
                  style={{
                    width: `${Math.max(0, Math.min(100, ((piStatus()?.audioLevelDbfs ?? -120) + 90) * 1.67))}%`,
                  }}
                />
              </div>
            </section>

            <section>
              <span class="pi-eval__step">03 · Scheduler</span>
              <div class="pi-eval__mode-picker">
                <button
                  type="button"
                  classList={{ 'is-selected': timingMode() === 'adaptive' }}
                  onClick={() => setTimingMode('adaptive')}
                >
                  <strong>Adaptive</strong>
                  <span>Current live behavior</span>
                </button>
                <button
                  type="button"
                  classList={{ 'is-selected': timingMode() === 'fixed' }}
                  onClick={() => setTimingMode('fixed')}
                >
                  <strong>Fixed + buffer</strong>
                  <span>Stable epoch, +1.75s</span>
                </button>
              </div>
            </section>

            <section class="pi-eval__run-card">
              <button
                class="pi-eval__run"
                type="button"
                disabled={
                  !sourcePairValid() || !props.connected() || isEvaluating()
                }
                onClick={() => void runEvaluation()}
              >
                {isEvaluating() ? 'Evaluation running…' : 'Run evaluation'}
              </button>
              <button
                type="button"
                disabled={!isEvaluating() && !playbackRunning()}
                onClick={stopAudio}
              >
                Stop audio
              </button>
              <div
                class="pi-eval__progress"
                role="progressbar"
                aria-label="Evaluation progress"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow={Math.round(progress() * 100)}
              >
                <span style={{ width: `${progress() * 100}%` }} />
              </div>
              <p class="pi-eval__status">{state()}</p>
            </section>

            <section class="pi-eval__session-tools">
              <span class="pi-eval__step">Sessions</span>
              <div>
                <label class="pi-eval__file">
                  Import run
                  <input
                    type="file"
                    accept=".json"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      if (file) void importRun(file, false)
                    }}
                  />
                </label>
                <label class="pi-eval__file">
                  Compare
                  <input
                    type="file"
                    accept=".json"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      if (file) void importRun(file, true)
                    }}
                  />
                </label>
              </div>
              <Show when={run()}>
                {(current) => (
                  <button
                    type="button"
                    onClick={() =>
                      downloadJson(
                        `${current().referenceName}-${current().timingMode}-evaluation.json`,
                        current(),
                      )
                    }
                  >
                    Export current run
                  </button>
                )}
              </Show>
            </section>
          </aside>

          <main class="pi-eval__main">
            <nav class="pi-eval__tabs" aria-label="Evaluation views">
              <For
                each={
                  [
                    ['overview', 'Overview'],
                    ['replay', 'Replay'],
                    ['diagnostics', 'Diagnostics'],
                  ] as const
                }
              >
                {(view) => (
                  <button
                    type="button"
                    classList={{ 'is-active': activeView() === view[0] }}
                    disabled={!run()}
                    onClick={() => setActiveView(view[0])}
                  >
                    {view[1]}
                  </button>
                )}
              </For>
            </nav>

            <Show
              when={run()}
              fallback={
                <Show
                  when={isEvaluating()}
                  fallback={
                    <div class="pi-eval__empty">
                      <span>Ready for a controlled loop test</span>
                      <h3>Load a MIDI, verify the Pi input meter, then run.</h3>
                      <p>
                        The result will include note accuracy, timing drift, tempo stability,
                        audio severity, two replayable MIDIs, and a seekable error timeline.
                      </p>
                      <ol>
                        <li>Choose the reference MIDI.</li>
                        <li>Route Windows audio to the Pi Bluetooth endpoint.</li>
                        <li>Run and leave this tab active until analysis completes.</li>
                      </ol>
                    </div>
                  }
                >
                  <div class="pi-eval__live">
                    <div class="pi-eval__live-heading">
                      <div>
                        <span>Live Pi telemetry · decoded in real time</span>
                        <h3>Evaluation in progress</h3>
                      </div>
                      <strong>{Math.round(progress() * 100)}%</strong>
                    </div>
                    <div class="pi-eval__live-stats">
                      <Metric
                        label="Input"
                        value={`${(piStatus()?.audioLevelDbfs ?? -120).toFixed(0)} dBFS`}
                      />
                      <Metric
                        label="Inference"
                        value={`${(piStatus()?.computeMs ?? 0).toFixed(0)} ms`}
                      />
                      <Metric
                        label="Slack"
                        value={`${(piStatus()?.slackMs ?? 0).toFixed(0)} ms`}
                      />
                      <Metric
                        label="Decoded events"
                        value={String(piStatus()?.eventCount ?? 0)}
                      />
                    </div>
                    <div class="pi-eval__live-charts">
                      <Timeline title="Live input level (dBFS)" path={liveAudioPath()} />
                      <Timeline title="Live inference time (ms)" path={liveComputePath()} />
                      <Timeline title="Live scheduler slack (ms)" path={liveSlackPath()} />
                    </div>
                    <p>
                      These traces come from the Pi status stream. Raw PCM waveform samples are
                      not transmitted to the browser.
                    </p>
                  </div>
                </Show>
              }
            >
              {(current) => (
                <>
                  <Show when={activeView() === 'overview'}>
                    <div class="pi-eval__result-heading">
                      <div>
                        <span>{current().timingMode} scheduler</span>
                        <h3>{current().referenceName}</h3>
                      </div>
                      <time>{new Date(current().createdAt).toLocaleString()}</time>
                    </div>
                    <div class="pi-eval__metrics">
                      <Metric
                        label="Precision"
                        value={`${(current().metrics.precision * 100).toFixed(1)}%`}
                      />
                      <Metric
                        label="Recall"
                        value={`${(current().metrics.recall * 100).toFixed(1)}%`}
                      />
                      <Metric
                        label="Drift"
                        value={`${current().metrics.cumulativeDriftMs.toFixed(0)} ms`}
                      />
                      <Metric
                        label="IOI p90"
                        value={`${current().metrics.ioiP90Ms.toFixed(1)} ms`}
                      />
                      <Metric
                        label="Offset p90"
                        value={`${current().metrics.p90AbsOffsetErrorMs.toFixed(1)} ms`}
                      />
                      <Metric
                        label="Duration p90"
                        value={`${current().metrics.p90AbsDurationErrorMs.toFixed(1)} ms`}
                      />
                      <Metric
                        label="Early releases"
                        value={String(current().metrics.prematureReleases)}
                      />
                      <Metric label="Stuck notes" value={String(current().metrics.stuckNotes)} />
                      <Metric label="Hiccups" value={String(current().metrics.hiccups50)} />
                      <Metric
                        label="Suppressed"
                        value={String(current().metrics.suppressedOnsets)}
                      />
                      <Metric
                        label="Dropped"
                        value={`${current().metrics.droppedAudioMs.toFixed(0)} ms`}
                      />
                      <Metric
                        label="Audio severity"
                        value={audioResult() ? audioResult()!.p90Severity.toFixed(3) : 'Not cached'}
                      />
                    </div>
                    <div class="pi-eval__chart-grid">
                      <Timeline title="Cumulative lead / lag (ms)" path={lagPath()} />
                      <Timeline title="Local tempo ratio" path={tempoPath()} />
                      <Show when={audioResult()}>
                        <Timeline title="Canonical-audio severity" path={severityPath()} />
                      </Show>
                    </div>
                  </Show>

                  <Show when={activeView() === 'replay'}>
                    <div class="pi-eval__replay">
                      <div class="pi-eval__result-heading">
                        <div>
                          <span>A/B transport</span>
                          <h3>Replay and inspect timing errors</h3>
                        </div>
                        <strong>{playbackRunning() ? 'Playing' : 'Stopped'}</strong>
                      </div>
                      <div class="pi-eval__transport">
                        <button
                          type="button"
                          classList={{ 'is-selected': playbackTarget() === 'reference' }}
                          onClick={() => void playResult('reference', playbackTime())}
                        >
                          <span>A</span>
                          <strong>Original MIDI</strong>
                        </button>
                        <button
                          type="button"
                          disabled={!reconstructedMidi()}
                          classList={{ 'is-selected': playbackTarget() === 'reconstructed' }}
                          onClick={() => void playResult('reconstructed', playbackTime())}
                        >
                          <span>B</span>
                          <strong>Reconstructed MIDI</strong>
                        </button>
                        <button type="button" class="is-stop" onClick={stopAudio}>
                          Stop
                        </button>
                      </div>
                      <ErrorTimeline
                        duration={midi()?.duration ?? 1}
                        markers={errorMarkers()}
                        cursorTime={playbackTime()}
                        onSeek={(time) => void playResult(playbackTarget(), time)}
                      />
                      <Show when={playbackTarget() === 'reference' ? midi() : reconstructedMidi()}>
                        {(scoreMidi) => (
                          <EvaluationScore
                            midi={scoreMidi()}
                            cursorTime={playbackTime()}
                            playing={playbackRunning()}
                            markers={errorMarkers()}
                            target={playbackTarget()}
                            onSeek={(time) => void playResult(playbackTarget(), time)}
                          />
                        )}
                      </Show>
                      <div class="pi-eval__legend-row">
                        <span>
                          <i class="is-cursor" /> Playback cursor
                        </span>
                        <span>
                          <i class="is-timing" /> Timing &gt;50ms
                        </span>
                        <span>
                          <i class="is-missing" /> Missing
                        </span>
                        <span>
                          <i class="is-extra" /> Extra
                        </span>
                        <span>Release markers show early/late note endings</span>
                        <span>Click anywhere to seek and play</span>
                      </div>
                    </div>
                  </Show>

                  <Show when={activeView() === 'diagnostics'}>
                    <div class="pi-eval__diagnostic-grid">
                      <div class="pi-eval__table">
                        <h3>Worst timing events</h3>
                        <div class="is-head">
                          <span>Time</span>
                          <span>Cause</span>
                          <span>Error</span>
                        </div>
                        <For
                          each={current()
                            .metrics.hiccups.slice()
                            .sort((a, b) => b.magnitudeMs - a.magnitudeMs)
                            .slice(0, 20)}
                        >
                          {(hiccup) => (
                            <button
                              type="button"
                              onClick={() => {
                                setActiveView('replay')
                                void playResult(playbackTarget(), hiccup.time)
                              }}
                            >
                              <span>{formatTimelineTime(hiccup.time)}</span>
                              <span>{hiccup.kind}</span>
                              <strong>{hiccup.magnitudeMs.toFixed(1)} ms</strong>
                            </button>
                          )}
                        </For>
                      </div>
                      <div class="pi-eval__trace-summary">
                        <h3>Trace integrity</h3>
                        <Metric
                          label="Reference notes"
                          value={String(current().metrics.referenceCount)}
                        />
                        <Metric
                          label="Detected notes"
                          value={String(current().metrics.detectedCount)}
                        />
                        <Metric
                          label="Emitted notes"
                          value={String(current().metrics.emittedCount)}
                        />
                        <Metric label="Late events" value={String(current().metrics.lateEvents)} />
                      </div>
                    </div>
                    <Show when={compareRun()}>
                      <Comparison left={current()} right={compareRun()!} />
                    </Show>
                  </Show>
                </>
              )}
            </Show>
          </main>
        </div>
      </section>
    </Show>
  )
}

function StatusChip(props: { label: string; value: string; ok: boolean }) {
  return (
    <div class="pi-eval__chip" classList={{ 'is-ok': props.ok }}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  )
}

function Metric(props: { label: string; value: string }) {
  return (
    <div>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  )
}

function Timeline(props: { title: string; path: string }) {
  return (
    <div class="pi-eval__chart">
      <h3>{props.title}</h3>
      <svg viewBox="0 0 800 150" role="img" aria-label={props.title}>
        <line x1="0" y1="75" x2="800" y2="75" />
        <path d={props.path} />
      </svg>
    </div>
  )
}

function ErrorTimeline(props: {
  duration: number
  markers: TimelineErrorMarker[]
  cursorTime: number
  onSeek: (time: number) => void
}) {
  const width = 800
  return (
    <div class="pi-eval__error-timeline">
      <button
        type="button"
        aria-label="Replay from position on timing error time bar"
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          props.onSeek(((event.clientX - bounds.left) / bounds.width) * props.duration)
        }}
      >
        <svg viewBox={`0 0 ${width} 72`} role="img" aria-label="Timing error time bar">
          <rect class="pi-eval__error-track" x="0" y="30" width={width} height="12" rx="6" />
          <For each={props.markers}>
            {(marker) => {
              const x = Math.max(0, Math.min(width - 3, (marker.time / props.duration) * width))
              const height = Math.min(56, 14 + marker.magnitudeMs / 4)
              return (
                <rect
                  class={`pi-eval__error-marker is-${marker.kind}`}
                  x={x}
                  y={(72 - height) / 2}
                  width="3"
                  height={height}
                >
                  <title>
                    {marker.time.toFixed(2)}s — {marker.kind}
                    {marker.kind === 'timing' ? `, ${marker.magnitudeMs.toFixed(1)} ms` : ''}
                  </title>
                </rect>
              )
            }}
          </For>
          <line
            class="pi-eval__playback-cursor"
            x1={(props.cursorTime / props.duration) * width}
            y1="4"
            x2={(props.cursorTime / props.duration) * width}
            y2="68"
          />
        </svg>
      </button>
      <div>
        <span>0:00</span>
        <strong>
          {formatTimelineTime(props.cursorTime)} / {formatTimelineTime(props.duration)}
        </strong>
        <span>{formatTimelineTime(props.duration)}</span>
      </div>
    </div>
  )
}

function formatTimelineTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}`
}

function Comparison(props: { left: EvaluationRun; right: EvaluationRun }) {
  const rows = [
    ['Recall', props.left.metrics.recall * 100, props.right.metrics.recall * 100, '%'],
    ['Drift', props.left.metrics.cumulativeDriftMs, props.right.metrics.cumulativeDriftMs, 'ms'],
    ['IOI p90', props.left.metrics.ioiP90Ms, props.right.metrics.ioiP90Ms, 'ms'],
    ['Hiccups >50', props.left.metrics.hiccups50, props.right.metrics.hiccups50, ''],
    ['Suppressed', props.left.metrics.suppressedOnsets, props.right.metrics.suppressedOnsets, ''],
    ['Dropped', props.left.metrics.droppedAudioMs, props.right.metrics.droppedAudioMs, 'ms'],
  ] as const
  return (
    <div class="pi-eval__comparison">
      <h3>
        {props.left.timingMode} versus {props.right.timingMode}
      </h3>
      <div class="pi-eval__comparison-head">
        <span>Metric</span>
        <strong>{props.left.timingMode}</strong>
        <strong>{props.right.timingMode}</strong>
      </div>
      <For each={rows}>
        {(row) => (
          <div>
            <span>{row[0]}</span>
            <span>
              {row[1].toFixed(row[3] === '%' ? 1 : 0)}
              {row[3]}
            </span>
            <span>
              {row[2].toFixed(row[3] === '%' ? 1 : 0)}
              {row[3]}
            </span>
          </div>
        )}
      </For>
    </div>
  )
}
