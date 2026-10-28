import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Measurement-only config. `scripts/measure-team-latency.measure.ts` boots the
 * real service and runtime against in-memory doubles and prints timing tables;
 * it is not part of `npm test` and never runs in the product.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, '..'),
  test: {
    include: ['scripts/measure-team-latency.measure.ts'],
    testTimeout: 120_000,
    fileParallelism: false,
  },
})
