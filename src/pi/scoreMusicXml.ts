import type { MidiFile } from '../core/midi/types'
import type { EvalEvent } from './evaluation'

const DIVISIONS = 4
const QUANTUM_SECONDS_AT_120_BPM = 60 / 120 / DIVISIONS

interface WrittenNote {
  pitch: number
  start: number
  end: number
  voice: number
  chord: boolean
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function pitchXml(midiPitch: number): string {
  const pitchClasses = [
    ['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0],
    ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0],
  ] as const
  const [step, alter] = pitchClasses[((midiPitch % 12) + 12) % 12] ?? ['C', 0]
  return `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${Math.floor(midiPitch / 12) - 1}</octave></pitch>`
}

function durationPieces(ticks: number): number[] {
  const values = [16, 12, 8, 6, 4, 3, 2, 1]
  const pieces: number[] = []
  let remaining = Math.max(1, Math.round(ticks))
  for (const value of values) {
    while (remaining >= value) {
      pieces.push(value)
      remaining -= value
    }
  }
  return pieces
}

function notation(ticks: number): { type: string; dotted: boolean } {
  const values: Record<number, [string, boolean]> = {
    1: ['16th', false], 2: ['eighth', false], 3: ['eighth', true],
    4: ['quarter', false], 6: ['quarter', true], 8: ['half', false],
    12: ['half', true], 16: ['whole', false],
  }
  const [type, dotted] = values[ticks] ?? ['16th', false]
  return { type, dotted }
}

function restXml(ticks: number, voice: number, staff: number): string {
  return durationPieces(ticks)
    .map((duration) => {
      const mark = notation(duration)
      return `<note><rest/><duration>${duration}</duration><voice>${voice}</voice><type>${mark.type}</type>${mark.dotted ? '<dot/>' : ''}<staff>${staff}</staff></note>`
    })
    .join('')
}

function noteXml(
  pitch: number,
  ticks: number,
  voice: number,
  staff: number,
  tieStart: boolean,
  tieStop: boolean,
  chord: boolean,
): string {
  const mark = notation(ticks)
  const ties = `${tieStop ? '<tie type="stop"/>' : ''}${tieStart ? '<tie type="start"/>' : ''}`
  const tied = `${tieStop ? '<tied type="stop"/>' : ''}${tieStart ? '<tied type="start"/>' : ''}`
  return `<note>${chord ? '<chord/>' : ''}${pitchXml(pitch)}<duration>${ticks}</duration>${ties}<voice>${voice}</voice><type>${mark.type}</type>${mark.dotted ? '<dot/>' : ''}<staff>${staff}</staff>${tied ? `<notations>${tied}</notations>` : ''}</note>`
}

function assignVoices(events: readonly EvalEvent[], secondsPerTick: number): WrittenNote[] {
  const sorted = events
    .map((event) => ({
      pitch: event.pitch,
      start: Math.max(0, Math.round(event.time / secondsPerTick)),
      end: Math.max(1, Math.round((event.time + event.duration) / secondsPerTick)),
    }))
    .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
  const voiceEnds: number[] = []
  const written: WrittenNote[] = []
  for (const note of sorted) {
    const compatible = written.find(
      (item) => item.start === note.start && item.end === Math.max(note.start + 1, note.end),
    )
    if (compatible) {
      written.push({ ...note, end: compatible.end, voice: compatible.voice, chord: true })
      continue
    }
    let voice = voiceEnds.findIndex((end) => end <= note.start)
    if (voice < 0) voice = voiceEnds.length
    voiceEnds[voice] = Math.max(note.start + 1, note.end)
    written.push({
      ...note,
      end: Math.max(note.start + 1, note.end),
      voice: voice + 1,
      chord: false,
    })
  }
  return written
}

function measureStaffXml(
  notes: readonly WrittenNote[],
  measureStart: number,
  measureTicks: number,
  staff: number,
): string {
  const measureEnd = measureStart + measureTicks
  const voices = [...new Set(notes.map((note) => note.voice))].sort((a, b) => a - b)
  if (!voices.length) return restXml(measureTicks, 1, staff)
  return voices
    .map((voice, voiceIndex) => {
      let cursor = measureStart
      let xml = voiceIndex ? `<backup><duration>${measureTicks}</duration></backup>` : ''
      for (const note of notes.filter((item) => item.voice === voice)) {
        const start = Math.max(measureStart, note.start)
        const end = Math.min(measureEnd, note.end)
        if (start >= end) continue
        if (start > cursor) xml += restXml(start - cursor, voice, staff)
        const pieces = durationPieces(end - start)
        for (let index = 0; index < pieces.length; index++) {
          const piece = pieces[index] ?? 1
          xml += noteXml(
            note.pitch,
            piece,
            voice,
            staff,
            index < pieces.length - 1 || end < note.end,
            note.start < measureStart || index > 0,
            note.chord,
          )
        }
        if (!note.chord) cursor = end
      }
      if (cursor < measureEnd) xml += restXml(measureEnd - cursor, voice, staff)
      return xml
    })
    .join('')
}

export interface ScorePreparation {
  xml: string
  bpm: number
  duration: number
  quantizationSeconds: number
}

/**
 * Produces diagnostic notation. Each note's predicted duration is quantized;
 * overlaps use independent voices and notes crossing bar lines are tied.
 */
export function evaluationEventsToMusicXml(
  name: string,
  events: readonly EvalEvent[],
  midi: Pick<MidiFile, 'bpm' | 'timeSignature' | 'duration'>,
): ScorePreparation {
  const bpm = Math.max(20, Math.min(300, midi.bpm || 120))
  const [beats, beatType] = midi.timeSignature
  const secondsPerTick = 60 / bpm / DIVISIONS
  const measureTicks = Math.max(1, Math.round((beats * DIVISIONS * 4) / beatType))
  const duration = Math.max(midi.duration, ...events.map((event) => event.time + event.duration), 1)
  const measureCount = Math.max(1, Math.ceil(duration / (measureTicks * secondsPerTick)))
  const byStaff = [1, 2].map((staff) =>
    assignVoices(
      events.filter((event) => (event.pitch >= 60 ? 1 : 2) === staff),
      secondsPerTick,
    ),
  )
  const measures = Array.from({ length: measureCount }, (_, index) => {
    const start = index * measureTicks
    const end = start + measureTicks
    const attributes =
      index === 0
        ? `<attributes><divisions>${DIVISIONS}</divisions><key><fifths>0</fifths></key><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(bpm)}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>`
        : ''
    const active = (staff: number) =>
      byStaff[staff - 1]?.filter((note) => note.start < end && note.end > start) ?? []
    return `<measure number="${index + 1}">${attributes}${measureStaffXml(active(1), start, measureTicks, 1)}<backup><duration>${measureTicks}</duration></backup>${measureStaffXml(active(2), start, measureTicks, 2)}</measure>`
  }).join('')
  return {
    bpm,
    duration,
    quantizationSeconds: secondsPerTick || QUANTUM_SECONDS_AT_120_BPM,
    xml: `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${xmlEscape(name)}</work-title></work><identification><encoding><software>Midee reconstruction inspector</software></encoding></identification><part-list><score-part id="P1"><part-name>Piano reconstruction</part-name><score-instrument id="P1-I1"><instrument-name>Piano</instrument-name></score-instrument><midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>1</midi-program></midi-instrument></score-part></part-list><part id="P1">${measures}</part></score-partwise>`,
  }
}
