import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

export const env = createEnv({
  clientPrefix: 'VITE_',
  client: {
    VITE_ENABLE_LEARN_MODE: z
      .union([z.string(), z.boolean()])
      .optional()
      .transform((v) => v === true || v === 'true'),
    // Build-time gate for the bench runner. Set by `npm run bench`; absent in
    // public prod builds. NOTE: the gate in main.tsx reads `import.meta.env`
    // directly (not this object) so Vite can constant-fold the dead branch
    // and tree-shake `bench/runner.ts` out of the bundle.
    VITE_ENABLE_BENCH: z
      .union([z.string(), z.boolean()])
      .optional()
      .transform((v) => v === true || v === 'true' || v === '1'),
    VITE_POSTHOG_KEY: z.string().optional(),
    VITE_POSTHOG_HOST: z.string().optional(),
  },
  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
})

export const ENABLE_LEARN_MODE = env.VITE_ENABLE_LEARN_MODE
