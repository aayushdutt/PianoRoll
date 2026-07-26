/**
 * Minimal PCM WAV decoder + linear resampler.
 *
 * basic-pitch's `BasicPitch.evaluateModel()` accepts a plain mono
 * Float32Array at 22050 Hz directly (see upstream src/inference.ts), so a
 * full Web Audio API `AudioContext.decodeAudioData` is not required to run
 * real inference in Node -- we just need to get GuitarSet's 44.1kHz mono
 * WAV files into that shape ourselves. No dependencies.
 */
import { readFileSync } from 'node:fs';

/**
 * @param {string} wavPath
 * @returns {{sampleRate:number, channelData:Float32Array[], numFrames:number}}
 */
export function readWavPcm(wavPath) {
  const buf = readFileSync(wavPath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Not a RIFF/WAVE file: ${wavPath}`);
  }

  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(chunkStart),
        numChannels: buf.readUInt16LE(chunkStart + 2),
        sampleRate: buf.readUInt32LE(chunkStart + 4),
        bitsPerSample: buf.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data') {
      dataOffset = chunkStart;
      dataSize = chunkSize;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  if (!fmt || dataOffset === -1) {
    throw new Error(`Missing fmt/data chunk in ${wavPath}`);
  }
  if (fmt.audioFormat !== 1) {
    throw new Error(`Only PCM WAV supported (audioFormat=${fmt.audioFormat}) in ${wavPath}`);
  }
  if (fmt.bitsPerSample !== 16) {
    throw new Error(`Only 16-bit PCM supported (bitsPerSample=${fmt.bitsPerSample}) in ${wavPath}`);
  }

  const bytesPerSample = 2;
  const frameSize = bytesPerSample * fmt.numChannels;
  const numFrames = Math.floor(dataSize / frameSize);
  const channelData = Array.from({ length: fmt.numChannels }, () => new Float32Array(numFrames));

  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < fmt.numChannels; ch++) {
      const sampleOffset = dataOffset + i * frameSize + ch * bytesPerSample;
      channelData[ch][i] = buf.readInt16LE(sampleOffset) / 32768;
    }
  }

  return { sampleRate: fmt.sampleRate, channelData, numFrames };
}

/**
 * Downmix to mono (average channels) and linearly resample to targetRate.
 * @param {{sampleRate:number, channelData:Float32Array[], numFrames:number}} wav
 * @param {number} targetRate
 * @returns {Float32Array}
 */
export function toMonoResampled(wav, targetRate) {
  const { sampleRate, channelData, numFrames } = wav;
  const mono = new Float32Array(numFrames);
  const numChannels = channelData.length;
  for (let i = 0; i < numFrames; i++) {
    let sum = 0;
    for (let ch = 0; ch < numChannels; ch++) sum += channelData[ch][i];
    mono[i] = sum / numChannels;
  }
  if (sampleRate === targetRate) return mono;

  const ratio = sampleRate / targetRate;
  const outLength = Math.floor(numFrames / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, numFrames - 1);
    const frac = srcPos - i0;
    out[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
  }
  return out;
}
