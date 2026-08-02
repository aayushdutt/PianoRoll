import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import type { MidiFile } from '../core/midi/types'
import { flattenMidi } from './evaluation'
import { evaluationEventsToMusicXml } from './scoreMusicXml'

interface ScoreMarker {
  time: number
  kind: 'timing' | 'early-release' | 'late-release' | 'missing' | 'extra' | 'drop'
}

interface Props {
  midi: MidiFile
  cursorTime: number
  playing: boolean
  markers: readonly ScoreMarker[]
  target: 'reference' | 'reconstructed'
  onSeek: (time: number) => void
}

export function EvaluationScore(props: Props) {
  const [state, setState] = createSignal<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = createSignal('')
  let host: HTMLDivElement | undefined
  let viewport: HTMLDivElement | undefined
  let osmd: OpenSheetMusicDisplay | undefined
  let renderedMidi: MidiFile | undefined
  let lastCursorTime = -1
  let disposed = false

  const preparation = createMemo(() =>
    evaluationEventsToMusicXml(props.midi.name, flattenMidi(props.midi), props.midi),
  )
  const measureDuration = createMemo(() => {
    const [beats, beatType] = props.midi.timeSignature
    return (beats * 4 * 60) / beatType / Math.max(20, props.midi.bpm)
  })
  const measures = createMemo(() => {
    const seconds = measureDuration()
    const count = Math.max(1, Math.ceil(props.midi.duration / seconds))
    return Array.from({ length: count }, (_, index) => {
      const start = index * seconds
      const end = start + seconds
      return {
        number: index + 1,
        start,
        errors: props.markers.filter((marker) => marker.time >= start && marker.time < end).length,
      }
    })
  })
  const currentMeasure = createMemo(() =>
    Math.min(measures().length, Math.floor(props.cursorTime / measureDuration()) + 1),
  )

  createEffect(() => {
    const midi = props.midi
    const xml = preparation().xml
    if (!host || renderedMidi === midi) return
    renderedMidi = midi
    setState('loading')
    setError('')
    void (async () => {
      try {
        const { OpenSheetMusicDisplay } = await import('opensheetmusicdisplay')
        if (disposed || !host) return
        osmd?.clear()
        osmd = new OpenSheetMusicDisplay(host, {
          autoResize: true,
          backend: 'svg',
          drawTitle: false,
          drawingParameters: 'compacttight',
          followCursor: false,
          cursorsOptions: [
            {
              type: 2,
              color: '#ef4444',
              alpha: 0.72,
              follow: false,
            },
          ],
        })
        osmd.Zoom = 0.72
        await osmd.load(xml)
        if (disposed) return
        osmd.render()
        osmd.cursor.show()
        osmd.cursor.reset()
        lastCursorTime = -1
        setState('ready')
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Unable to engrave this score.')
        setState('error')
      }
    })()
  })

  createEffect(() => {
    const time = props.cursorTime
    if (state() !== 'ready' || !osmd || Math.abs(time - lastCursorTime) < 0.08) return
    const secondsPerWholeNote = (240 / Math.max(20, props.midi.bpm)) as number
    if (time < lastCursorTime || lastCursorTime < 0) osmd.cursor.reset()
    let guard = 0
    while (
      !osmd.cursor.Iterator.EndReached &&
      osmd.cursor.Iterator.CurrentSourceTimestamp.RealValue * secondsPerWholeNote < time &&
      guard < 100_000
    ) {
      osmd.cursor.next()
      guard++
    }
    osmd.cursor.show()
    lastCursorTime = time
    if (props.playing && viewport) {
      const cursor = osmd.cursor.cursorElement
      const cursorTop = cursor.offsetTop
      const viewportTop = viewport.scrollTop
      if (cursorTop < viewportTop + 32 || cursorTop > viewportTop + viewport.clientHeight - 100) {
        viewport.scrollTo({ top: Math.max(0, cursorTop - 80), behavior: 'smooth' })
      }
    }
  })

  onCleanup(() => {
    disposed = true
    osmd?.cursor.Dispose()
    osmd?.clear()
  })

  return (
    <section class="pi-score" aria-label="Synchronized evaluation sheet music">
      <header class="pi-score__header">
        <div>
          <span>Score follow</span>
          <strong>
            {props.target === 'reference' ? 'Original performance' : 'Pi reconstruction'}
          </strong>
        </div>
        <p>
          Quantized to 1/16 notes for diagnosis · bar {currentMeasure()} of {measures().length}
        </p>
      </header>
      <nav class="pi-score__measures" aria-label="Jump to measure">
        <For each={measures()}>
          {(measure) => (
            <button
              type="button"
              classList={{
                'is-current': measure.number === currentMeasure(),
                'has-errors': measure.errors > 0,
              }}
              title={
                measure.errors
                  ? `Bar ${measure.number}: ${measure.errors} flagged timing events`
                  : `Play from bar ${measure.number}`
              }
              onClick={() => props.onSeek(measure.start)}
            >
              <span>{measure.number}</span>
              <Show when={measure.errors}>
                <i>{measure.errors}</i>
              </Show>
            </button>
          )}
        </For>
      </nav>
      <div class="pi-score__viewport" ref={viewport}>
        <div class="pi-score__canvas" ref={host} />
        <Show when={state() === 'loading'}>
          <div class="pi-score__state">Engraving score…</div>
        </Show>
        <Show when={state() === 'error'}>
          <div class="pi-score__state is-error">{error()}</div>
        </Show>
      </div>
      <footer>
        Red cursor follows playback. Numbered red badges identify bars containing timing, missing,
        extra, or dropped-note events.
      </footer>
    </section>
  )
}
