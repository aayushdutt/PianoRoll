import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    alias: {
      // @tonejs/piano's MidiInput module imports Node's 'events' — polyfill for browser
      events: 'events',
    },
  },
  server: {
    headers: {
      // Required for ffmpeg.wasm (SharedArrayBuffer)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
})
