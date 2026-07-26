import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { useApp } from '../store/AppCtx'
import {
  applyLedMessage,
  LED_OUTPUT_COUNT,
  midiVelocityToUnit,
  parseLedMessageJson,
} from './ledProtocol'
import { activePitchesToOutputs, mismatchIndexes } from './ledState'
import './piPage.css'

const emptyOutputs = (): boolean[] => Array.from({ length: LED_OUTPUT_COUNT }, () => false)

// Raspberry Pi LED verification page (`?pi=1`). Renders over the normal player
// UI: midee's own active keys are the EXPECTED row; the Pi's audio-to-MIDI
// stream (Onsets & Velocities bridge over WebSocket) is the ACTUAL row.
export function PiPage() {
  const { services } = useApp()
  const [actual, setActual] = createSignal(emptyOutputs())
  const [socketUrl, setSocketUrl] = createSignal('ws://raspberrypi.local:8765/leds')
  const [socketStatus, setSocketStatus] = createSignal('disconnected')
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [hasActualSnapshot, setHasActualSnapshot] = createSignal(false)
  const [piPlayback, setPiPlayback] = createSignal({
    state: 'idle',
    song: '',
    position: 0,
    duration: 0,
    eventCount: 0,
  })
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const expected = createMemo(() =>
    activePitchesToOutputs(services.renderer.activeKeys.value.keys()),
  )
  const mismatches = createMemo(() =>
    hasActualSnapshot() ? mismatchIndexes(expected(), actual()) : new Set<number>(),
  )

  const connect = (): void => {
    clearTimeout(reconnectTimer)
    socket?.close()
    setSocketStatus('connecting')
    try {
      const nextSocket = new WebSocket(socketUrl())
      socket = nextSocket
      nextSocket.addEventListener('open', () => {
        if (socket === nextSocket) setSocketStatus('connected')
      })
      nextSocket.addEventListener('close', (event) => {
        if (socket !== nextSocket) return
        socket = null
        setSocketStatus(event.code === 1000 ? 'disconnected' : `disconnected (${event.code})`)
        if (!disposed) reconnectTimer = setTimeout(connect, 1500)
      })
      nextSocket.addEventListener('error', () => {
        if (socket === nextSocket) setSocketStatus('error')
      })
      nextSocket.addEventListener('message', (event) => {
        if (socket !== nextSocket) return
        if (typeof event.data !== 'string') return
        const message = parseLedMessageJson(event.data)
        if (!message) return
        if (message.type === 'status') {
          setPiPlayback(message)
          return
        }
        updateActual(
          applyLedMessage(actual(), message),
          message.type === 'set' && message.on
            ? { index: message.index, velocity: midiVelocityToUnit(message.velocity) }
            : undefined,
        )
      })
    } catch {
      setSocketStatus('invalid URL')
    }
  }

  onMount(connect)
  onCleanup(() => {
    disposed = true
    clearTimeout(reconnectTimer)
    socket?.close()
  })

  const updateActual = (next: boolean[], onset?: { index: number; velocity: number }): void => {
    const previous = actual()
    const clockTime = services.clock.currentTime
    for (let index = 0; index < 88; index++) {
      if (Boolean(previous[index]) === Boolean(next[index])) continue
      const pitch = index + 21
      if (next[index]) {
        const velocity = onset?.index === index ? onset.velocity : 0.8
        services.input.emitNoteOn({ pitch, velocity, clockTime }, 'pi')
      } else {
        services.input.emitNoteOff({ pitch, velocity: 0, clockTime }, 'pi')
      }
    }
    setActual(next)
    setHasActualSnapshot(true)
  }

  const sendCommand = (command: 'start' | 'pause' | 'resume' | 'stop'): void => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'command', command }))
  }

  const toggleActual = (index: number): void => {
    const next = [...actual()]
    next[index] = !next[index]
    updateActual(next)
  }

  return (
    <aside class="led-strip-harness" aria-label="LED strip verification harness">
      <div class="led-strip-harness__bar">
        <div class="led-strip-harness__title">
          <strong>LED harness</strong>
          <span class={`led-strip-harness__status is-${socketStatus()}`}>{socketStatus()}</span>
          <Show when={hasActualSnapshot()}>
            <span class="led-strip-harness__mismatch">{mismatches().size} mismatches</span>
          </Show>
          <Show when={piPlayback().song}>
            <span class="led-strip-harness__song">
              {piPlayback().song} · {piPlayback().state} · {Math.round(piPlayback().position)}s/
              {Math.round(piPlayback().duration)}s
            </span>
          </Show>
        </div>
        <div class="led-strip-harness__legend">
          <span>
            <i class="is-expected" />
            Expected
          </span>
          <span>
            <i class="is-actual" />
            Pi stream
          </span>
          <span>
            <i class="is-aux" />
            Aux 88-99
          </span>
        </div>
        <button type="button" onClick={() => setSettingsOpen((open) => !open)}>
          {settingsOpen() ? 'Hide connection' : 'Pi connection'}
        </button>
      </div>

      <Show when={settingsOpen()}>
        <div class="led-strip-harness__connection">
          <input
            aria-label="Pi WebSocket URL"
            value={socketUrl()}
            onInput={(event) => setSocketUrl(event.currentTarget.value)}
          />
          <button type="button" onClick={connect}>
            Connect
          </button>
          <button type="button" onClick={() => sendCommand('start')}>
            Start
          </button>
          <button type="button" onClick={() => sendCommand('pause')}>
            Pause
          </button>
          <button type="button" onClick={() => sendCommand('resume')}>
            Resume
          </button>
          <button type="button" onClick={() => sendCommand('stop')}>
            Stop
          </button>
          <button
            type="button"
            onClick={() => {
              updateActual(emptyOutputs())
              setHasActualSnapshot(false)
            }}
          >
            Reset Pi row
          </button>
        </div>
      </Show>

      <div class="led-strip-harness__rows">
        <div class="led-strip-harness__row">
          <span class="led-strip-harness__row-label">EXP</span>
          <For each={expected()}>
            {(on, index) => (
              <span
                class="led-strip-dot led-strip-dot--expected"
                classList={{
                  'is-on': on,
                  'is-aux': index() >= 88,
                  'is-mismatch': mismatches().has(index()),
                }}
                title={`Expected output ${index()}: ${on ? 'on' : 'off'}`}
              />
            )}
          </For>
        </div>
        <div class="led-strip-harness__row">
          <span class="led-strip-harness__row-label">PI</span>
          <For each={actual()}>
            {(on, index) => (
              <button
                type="button"
                class="led-strip-dot led-strip-dot--actual"
                classList={{
                  'is-on': on,
                  'is-aux': index() >= 88,
                  'is-mismatch': mismatches().has(index()),
                }}
                title={`Pi output ${index()}: ${on ? 'on' : 'off'} (click to toggle)`}
                onClick={() => toggleActual(index())}
              />
            )}
          </For>
        </div>
        <div class="led-strip-harness__ticks">
          <span />
          <For each={Array.from({ length: 100 }, (_, index) => index)}>
            {(index) => <span>{index % 10 === 0 || index === 99 ? index : ''}</span>}
          </For>
        </div>
      </div>
    </aside>
  )
}
