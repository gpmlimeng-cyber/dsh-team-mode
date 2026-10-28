import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Measurement-only config: every `scripts/*.measure.ts` prints a timing table
 * (latency stages, first-response benchmark) and none of it is part of
 * `npm test` or runs in the product.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  test: {
    include: ['scripts/*.measure.ts'],
    testTimeout: 120_000,
    fileParallelism: false,
  },
})
