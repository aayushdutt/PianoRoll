export interface PerceptualFrame {
  time: number
  severity: number
  referenceFlux: number
  reconstructedFlux: number
}

export interface AudioPerceptualResult {
  frameHopSeconds: number
  meanSeverity: number
  p90Severity: number
  worstTime: number
  frames: PerceptualFrame[]
}

const FFT_SIZE = 2048
const HOP_SIZE = 512
const BAND_COUNT = 24

function percentile(values: readonly number[], pct: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.round((sorted.length - 1) * pct)] ?? 0
}

function mono(buffer: AudioBuffer): Float32Array {
  const output = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const source = buffer.getChannelData(channel)
    for (let index = 0; index < output.length; index++) {
      output[index] = (output[index] ?? 0) + (source[index] ?? 0) / buffer.numberOfChannels
    }
  }
  return output
}

function fftMagnitudes(input: Float32Array): Float32Array {
  const real = new Float64Array(FFT_SIZE)
  const imag = new Float64Array(FFT_SIZE)
  for (let index = 0; index < FFT_SIZE; index++) {
    real[index] = input[index] ?? 0
  }
  for (let index = 1, target = 0; index < FFT_SIZE; index++) {
    let bit = FFT_SIZE >> 1
    while (target & bit) {
      target ^= bit
      bit >>= 1
    }
    target ^= bit
    if (index < target) {
      const value = real[index]
      real[index] = real[target] ?? 0
      real[target] = value ?? 0
    }
  }
  for (let length = 2; length <= FFT_SIZE; length <<= 1) {
    const angle = (-2 * Math.PI) / length
    const wLenR = Math.cos(angle)
    const wLenI = Math.sin(angle)
    for (let start = 0; start < FFT_SIZE; start += length) {
      let wr = 1
      let wi = 0
      for (let offset = 0; offset < length / 2; offset++) {
        const even = start + offset
        const odd = even + length / 2
        const oddR = real[odd] ?? 0
        const oddI = imag[odd] ?? 0
        const vr = oddR * wr - oddI * wi
        const vi = oddR * wi + oddI * wr
        const ur = real[even] ?? 0
        const ui = imag[even] ?? 0
        real[even] = ur + vr
        imag[even] = ui + vi
        real[odd] = ur - vr
        imag[odd] = ui - vi
        const nextWr = wr * wLenR - wi * wLenI
        wi = wr * wLenI + wi * wLenR
        wr = nextWr
      }
    }
  }
  const magnitudes = new Float32Array(FFT_SIZE / 2)
  for (let index = 0; index < magnitudes.length; index++) {
    magnitudes[index] = Math.hypot(real[index] ?? 0, imag[index] ?? 0)
  }
  return magnitudes
}

function bandEdges(sampleRate: number): number[] {
  const minHz = 27.5
  const maxHz = Math.min(8_000, sampleRate / 2)
  return Array.from({ length: BAND_COUNT + 1 }, (_, index) => {
    const hz = minHz * (maxHz / minHz) ** (index / BAND_COUNT)
    return Math.max(1, Math.min(FFT_SIZE / 2 - 1, Math.round((hz * FFT_SIZE) / sampleRate)))
  })
}

function onsetFlux(samples: Float32Array, sampleRate: number): Float32Array[] {
  const edges = bandEdges(sampleRate)
  const frameCount = Math.max(1, Math.floor((samples.length - FFT_SIZE) / HOP_SIZE) + 1)
  const output: Float32Array[] = []
  const previous = new Float32Array(BAND_COUNT)
  for (let frame = 0; frame < frameCount; frame++) {
    const window = new Float32Array(FFT_SIZE)
    const start = frame * HOP_SIZE
    for (let index = 0; index < FFT_SIZE; index++) {
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (FFT_SIZE - 1))
      window[index] = (samples[start + index] ?? 0) * hann
    }
    const spectrum = fftMagnitudes(window)
    const bands = new Float32Array(BAND_COUNT)
    for (let band = 0; band < BAND_COUNT; band++) {
      const low = edges[band] ?? 1
      const high = Math.max(low + 1, edges[band + 1] ?? low + 1)
      let energy = 0
      for (let bin = low; bin < high; bin++) energy += spectrum[bin] ?? 0
      const logEnergy = Math.log1p(energy / (high - low))
      bands[band] = Math.max(0, logEnergy - (previous[band] ?? 0))
      previous[band] = logEnergy
    }
    output.push(bands)
  }
  return output
}

export function compareRenderedAudio(
  reference: AudioBuffer,
  reconstruction: AudioBuffer,
): AudioPerceptualResult {
  return compareMonoAudio(mono(reference), mono(reconstruction), reference.sampleRate)
}

export function compareMonoAudio(
  reference: Float32Array,
  reconstruction: Float32Array,
  sampleRate: number,
): AudioPerceptualResult {
  const ref = onsetFlux(reference, sampleRate)
  const actual = onsetFlux(reconstruction, sampleRate)
  const count = Math.max(ref.length, actual.length)
  const frames: PerceptualFrame[] = []
  for (let frame = 0; frame < count; frame++) {
    const a = ref[frame] ?? new Float32Array(BAND_COUNT)
    const b = actual[frame] ?? new Float32Array(BAND_COUNT)
    let difference = 0
    let scale = 0
    let referenceFlux = 0
    let reconstructedFlux = 0
    for (let band = 0; band < BAND_COUNT; band++) {
      const av = a[band] ?? 0
      const bv = b[band] ?? 0
      difference += Math.abs(av - bv)
      scale += Math.max(av, bv)
      referenceFlux += av
      reconstructedFlux += bv
    }
    frames.push({
      time: (frame * HOP_SIZE) / sampleRate,
      severity: scale > 1e-6 ? difference / scale : 0,
      referenceFlux,
      reconstructedFlux,
    })
  }
  const severities = frames.map((frame) => frame.severity)
  const worst = frames.reduce(
    (result, frame) => (frame.severity > result.severity ? frame : result),
    frames[0] ?? { time: 0, severity: 0, referenceFlux: 0, reconstructedFlux: 0 },
  )
  return {
    frameHopSeconds: HOP_SIZE / sampleRate,
    meanSeverity:
      severities.reduce((sum, value) => sum + value, 0) / Math.max(1, severities.length),
    p90Severity: percentile(severities, 0.9),
    worstTime: worst.time,
    frames,
  }
}
