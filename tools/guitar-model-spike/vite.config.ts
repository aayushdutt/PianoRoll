import { defineConfig } from 'vite';

// Deliberately minimal: this config exists only to prove @spotify/basic-pitch
// bundles for a real browser target under this repo's pinned Vite major
// version (Vite 8, matching the root app's `vite: "^8.0.0"` in package.json).
// It is not wired into the root app and does not affect production builds.
export default defineConfig({
  root: __dirname,
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
});
