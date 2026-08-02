import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { useApp } from '../store/AppCtx'
import { EvaluationDashboard } from './EvaluationDashboard'
import {
  applyLedMessage,
  LED_OUTPUT_COUNT,
  midiVelocityToUnit,
  type LedMessage,
  parseLedMessageJson,
} from './ledProtocol'
import { activePitchesToOutputs, mismatchIndexes } from './ledState'
import './piPage.css'

const emptyOutputs = (): boolean[] => Array.from({ length: LED_OUTPUT_COUNT }, () => false)

// Raspberry Pi LED verification page (`?pi=1`). Renders over the normal player
// UI: midee's own active keys are the EXPECTED row; the Pi's audio-to-MIDI
// stream (Onsets & Velocities bridge over WebSocket) is the ACTUAL row.
export function PiPage() {
  const { services, primeInteractiveAudio } = useApp()
  const [hardwareOpen, setHardwareOpen] = createSignal(false)
  const [liveMonitor, setLiveMonitor] = createSignal(true)
  const [actual, setActual] = createSignal(emptyOutputs())
  const [socketUrl, setSocketUrl] = createSignal('ws://192.168.10.220:8765/leds')
  const [socketStatus, setSocketStatus] = createSignal('disconnected')
  const [lastMessage, setLastMessage] = createSignal<LedMessage | null>(null)
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
  const monitoredVoices = new Map<number, string>()
  let monitoredPedalDown = false

  const releaseMonitoredNotes = (): void => {
    for (const [index, voiceId] of monitoredVoices) {
      services.input.emitNoteOff(
        {
          pitch: index + 21,
          velocity: 0,
          clockTime: services.clock.currentTime,
          voiceId,
        },
        'pi',
      )
    }
    monitoredVoices.clear()
    if (monitoredPedalDown) {
      services.input.emitPedal(false, 'pi')
      monitoredPedalDown = false
    }
  }

  const monitorMessage = (message: LedMessage): void => {
    if (!liveMonitor()) return
    if (message.type === 'clear_all') {
      releaseMonitoredNotes()
      return
    }
    if (message.type === 'pedal') {
      if (message.down !== monitoredPedalDown) {
        services.input.emitPedal(message.down, 'pi')
        monitoredPedalDown = message.down
      }
      return
    }
    if (message.type !== 'set' || message.index >= 88) return

    const previousVoice = monitoredVoices.get(message.index)
    if (message.on) {
      if (previousVoice) {
        services.input.emitNoteOff(
          {
            pitch: message.index + 21,
            velocity: 0,
            clockTime: services.clock.currentTime,
            voiceId: previousVoice,
          },
          'pi',
        )
      }
      const voiceId = `pi:${message.eventId ?? `${message.index}:${performance.now()}`}`
      monitoredVoices.set(message.index, voiceId)
      services.input.emitNoteOn(
        {
          pitch: message.index + 21,
          velocity: midiVelocityToUnit(message.velocity),
          clockTime: services.clock.currentTime,
          voiceId,
        },
        'pi',
      )
    } else if (previousVoice) {
      services.input.emitNoteOff(
        {
          pitch: message.index + 21,
          velocity: 0,
          clockTime: services.clock.currentTime,
          voiceId: previousVoice,
        },
        'pi',
      )
      monitoredVoices.delete(message.index)
    }
  }

  const expected = createMemo(() =>
    activePitchesToOutputs(services.renderer.activeKeys.value.keys()),
  )
  const mismatches = createMemo(() =>
    hasActualSnapshot() ? mismatchIndexes(expected(), actual()) : new Set<number>(),
  )
  const bridgeStatus = createMemo(() => {
    const message = lastMessage()
    return message?.type === 'status' ? message : null
  })

  const connect = (): void => {
    clearTimeout(reconnectTimer)
    releaseMonitoredNotes()
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
        releaseMonitoredNotes()
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
        setLastMessage(message)
        if (message.type === 'status') {
          setPiPlayback(message)
          return
        }
        monitorMessage(message)
        updateActual(applyLedMessage(actual(), message))
      })
    } catch {
      setSocketStatus('invalid URL')
    }
  }

  onMount(() => {
    document.body.classList.add('pi-evaluation-page')
    connect()
  })
  onCleanup(() => {
    disposed = true
    document.body.classList.remove('pi-evaluation-page')
    clearTimeout(reconnectTimer)
    socket?.close()
    releaseMonitoredNotes()
    services.synth.liveReleaseAll()
  })

  const updateActual = (next: boolean[]): void => {
    // Pi events are telemetry, not user performance input. Sending them through
    // InputBus would trigger SynthEngine.liveNoteOn(), feed the decoded stream
    // back into Bluetooth, and mix a second generation into evaluation/replay.
    setActual(next)
    setHasActualSnapshot(true)
  }

  const sendCommand = (command: 'start' | 'pause' | 'resume' | 'stop'): void => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'command', command }))
  }

  const sendMessage = (message: object): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }

  const toggleActual = (index: number): void => {
    const next = [...actual()]
    next[index] = !next[index]
    updateActual(next)
  }

  return (
    <div class="pi-lab" classList={{ 'is-hardware-open': hardwareOpen() }}>
      <aside class="led-strip-harness" aria-label="LED strip verification harness">
        <div class="led-strip-harness__bar">
          <div class="led-strip-harness__title">
            <strong>Pi Reconstruction Lab</strong>
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
            <button
              type="button"
              class="led-strip-harness__toggle"
              aria-pressed={liveMonitor()}
              onClick={() => {
                primeInteractiveAudio()
                setLiveMonitor((enabled) => {
                  if (enabled) releaseMonitoredNotes()
                  return !enabled
                })
              }}
            >
              Live piano {liveMonitor() ? 'on' : 'off'}
            </button>
            <button
              type="button"
              class="led-strip-harness__toggle"
              aria-expanded={hardwareOpen()}
              onClick={() => setHardwareOpen((open) => !open)}
            >
              {hardwareOpen() ? 'Hide hardware' : 'Hardware diagnostics'}
            </button>
          </div>
        </div>

        <Show when={hardwareOpen()}>
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
            <span class="led-strip-harness__threshold">
              decoder {bridgeStatus()?.releaseDecoder ?? 'waiting'}
            </span>
            <span class="led-strip-harness__threshold">
              onset {bridgeStatus()?.threshold?.toFixed(2) ?? '—'}
            </span>
            <span class="led-strip-harness__threshold">
              key-up {bridgeStatus()?.frameOffThreshold?.toFixed(2) ?? '—'} ·{' '}
              {bridgeStatus()?.frameReleaseDebounce ?? '—'} frames
            </span>
            <span class="led-strip-harness__threshold">
              visible {bridgeStatus()?.minLedOnMs ?? '—'}ms
            </span>
          </div>

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
        </Show>
      </aside>
      <EvaluationDashboard
        connected={() => socketStatus() === 'connected'}
        message={lastMessage}
        send={sendMessage}
      />
    </div>
  )
}
