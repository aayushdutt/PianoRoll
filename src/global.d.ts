import type { BenchResult } from './bench/runner'

declare global {
  // Bench-only fields. The runner module + these props are gated behind
  // `import.meta.env.VITE_ENABLE_BENCH` in main.tsx, so they're absent from
  // public prod builds.
  interface Window {
    /** Set by `runBench` when `?bench=` is present (see `scripts/bench.mjs`). */
    __BENCH_RESULT?: BenchResult
    __BENCH_ERROR?: string
  }
}
