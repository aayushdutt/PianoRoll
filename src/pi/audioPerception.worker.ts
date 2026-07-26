/// <reference lib="webworker" />

import { compareMonoAudio } from './audioPerception'

interface Request {
  reference: Float32Array
  reconstruction: Float32Array
  sampleRate: number
}

self.addEventListener('message', (event: MessageEvent<Request>) => {
  const { reference, reconstruction, sampleRate } = event.data
  self.postMessage(compareMonoAudio(reference, reconstruction, sampleRate))
})
