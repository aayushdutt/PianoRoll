export const LED_OUTPUT_COUNT = 100

export interface LedSetMessage {
  type: 'set'
  index: number
  on: boolean
  color?: string
  velocity?: number
  t?: number
  eventId?: number
  sessionId?: string | null
}

export interface LedClearMessage {
  type: 'clear_all'
}

export interface LedSnapshotMessage {
  type: 'snapshot'
  outputs: readonly boolean[]
}

export type PiPlaybackState = 'idle' | 'playing' | 'paused' | 'stopped' | 'finished'

export interface PiStatusMessage {
  type: 'status'
  state: PiPlaybackState
  song: string
  position: number
  duration: number
  eventCount: number
  threshold?: number
  holdMs?: number
  energyOff?: boolean
  energyGate?: number
  timingMode?: TimingMode
  traceSessionId?: string | null
  traceActive?: boolean
  lookaheadS?: number
  computeMs?: number
  audioLevelDbfs?: number
  queuedEvents?: number
  slackMs?: number
  latencyBudgetMs?: number
  fixedExtraBufferMs?: number
  droppedAudioMs?: number
  resyncs?: number
  lateEvents?: number
  suppressedOnsets?: number
  epochAdjustmentMs?: number
}

export type TimingMode = 'adaptive' | 'fixed'

export interface EvaluationStartedMessage {
  type: 'evaluation_started'
  sessionId: string
  timingMode: TimingMode
}

export interface EvaluationStoppedMessage {
  type: 'evaluation_stopped'
  sessionId: string
  recordCount: number
}

export interface EvaluationTraceRecord {
  stage: string
  serverTime: number
  eventId?: number | null
  batchId?: number
  pitch?: number
  velocity?: number
  audioTime?: number
  dueTime?: number
  latenessMs?: number
  reason?: string
  kind?: string
  adjustmentMs?: number
  startAudioTime?: number
  endAudioTime?: number
  durationMs?: number
  timingMode?: TimingMode
}

export interface EvaluationTraceMessage {
  type: 'evaluation_trace'
  sessionId: string
  chunkIndex: number
  chunkCount: number
  records: EvaluationTraceRecord[]
}

export type LedMessage =
  | LedSetMessage
  | LedClearMessage
  | LedSnapshotMessage
  | PiStatusMessage
  | EvaluationStartedMessage
  | EvaluationStoppedMessage
  | EvaluationTraceMessage

function isOutputIndex(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) < LED_OUTPUT_COUNT
}

export function parseLedMessage(value: unknown): LedMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Record<string, unknown>
  if (message.type === 'clear_all') return { type: 'clear_all' }
  if (
    message.type === 'status' &&
    ['idle', 'playing', 'paused', 'stopped', 'finished'].includes(String(message.state)) &&
    typeof message.song === 'string' &&
    typeof message.position === 'number' &&
    typeof message.duration === 'number' &&
    typeof message.eventCount === 'number'
  ) {
    const status: PiStatusMessage = {
      type: 'status',
      state: message.state as PiPlaybackState,
      song: message.song,
      position: message.position,
      duration: message.duration,
      eventCount: message.eventCount,
    }
    if (typeof message.threshold === 'number') status.threshold = message.threshold
    if (typeof message.holdMs === 'number') status.holdMs = message.holdMs
    if (typeof message.energyOff === 'boolean') status.energyOff = message.energyOff
    if (typeof message.energyGate === 'number') status.energyGate = message.energyGate
    if (message.timingMode === 'adaptive' || message.timingMode === 'fixed') {
      status.timingMode = message.timingMode
    }
    if (typeof message.traceSessionId === 'string' || message.traceSessionId === null) {
      status.traceSessionId = message.traceSessionId
    }
    if (typeof message.traceActive === 'boolean') status.traceActive = message.traceActive
    for (const key of [
      'lookaheadS',
      'computeMs',
      'audioLevelDbfs',
      'queuedEvents',
      'slackMs',
      'latencyBudgetMs',
      'fixedExtraBufferMs',
      'droppedAudioMs',
      'resyncs',
      'lateEvents',
      'suppressedOnsets',
      'epochAdjustmentMs',
    ] as const) {
      if (typeof message[key] === 'number') status[key] = message[key]
    }
    return status
  }
  if (message.type === 'set' && isOutputIndex(message.index) && typeof message.on === 'boolean') {
    const parsed: LedSetMessage = { type: 'set', index: message.index, on: message.on }
    if (typeof message.color === 'string') parsed.color = message.color
    if (typeof message.velocity === 'number') parsed.velocity = message.velocity
    if (typeof message.t === 'number') parsed.t = message.t
    if (typeof message.eventId === 'number') parsed.eventId = message.eventId
    if (typeof message.sessionId === 'string' || message.sessionId === null) {
      parsed.sessionId = message.sessionId
    }
    return parsed
  }
  if (
    message.type === 'evaluation_started' &&
    typeof message.sessionId === 'string' &&
    (message.timingMode === 'adaptive' || message.timingMode === 'fixed')
  ) {
    return {
      type: 'evaluation_started',
      sessionId: message.sessionId,
      timingMode: message.timingMode,
    }
  }
  if (
    message.type === 'evaluation_stopped' &&
    typeof message.sessionId === 'string' &&
    Number.isInteger(message.recordCount)
  ) {
    return {
      type: 'evaluation_stopped',
      sessionId: message.sessionId,
      recordCount: Number(message.recordCount),
    }
  }
  if (
    message.type === 'evaluation_trace' &&
    typeof message.sessionId === 'string' &&
    Number.isInteger(message.chunkIndex) &&
    Number.isInteger(message.chunkCount) &&
    Array.isArray(message.records) &&
    message.records.every(
      (record) =>
        record &&
        typeof record === 'object' &&
        typeof (record as Record<string, unknown>).stage === 'string' &&
        typeof (record as Record<string, unknown>).serverTime === 'number',
    )
  ) {
    return {
      type: 'evaluation_trace',
      sessionId: message.sessionId,
      chunkIndex: Number(message.chunkIndex),
      chunkCount: Number(message.chunkCount),
      records: message.records as EvaluationTraceRecord[],
    }
  }
  if (
    message.type === 'snapshot' &&
    Array.isArray(message.outputs) &&
    message.outputs.length === LED_OUTPUT_COUNT &&
    message.outputs.every((output) => typeof output === 'boolean')
  ) {
    return { type: 'snapshot', outputs: message.outputs }
  }
  return null
}

export function parseLedMessageJson(json: string): LedMessage | null {
  try {
    return parseLedMessage(JSON.parse(json))
  } catch {
    return null
  }
}

/** Convert the Pi bridge's MIDI velocity (0-127) to Midee's 0-1 scale. */
export function midiVelocityToUnit(velocity: number | undefined, fallback = 0.8): number {
  if (velocity === undefined || !Number.isFinite(velocity)) return fallback
  return Math.max(0, Math.min(127, velocity)) / 127
}

export function applyLedMessage(outputs: readonly boolean[], message: LedMessage): boolean[] {
  if (
    message.type === 'status' ||
    message.type === 'evaluation_started' ||
    message.type === 'evaluation_stopped' ||
    message.type === 'evaluation_trace'
  ) {
    return [...outputs]
  }
  if (message.type === 'clear_all') return Array.from({ length: LED_OUTPUT_COUNT }, () => false)
  if (message.type === 'snapshot') return [...message.outputs]
  const next = [...outputs]
  next[message.index] = message.on
  return next
}
