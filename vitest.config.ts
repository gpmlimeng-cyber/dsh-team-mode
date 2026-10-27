import { defineConfig } from 'vitest/config'

/**
 * A few specs shell out to real `git` and render diffs (4–6 s on a loaded
 * machine). The 5 s default turned those into flaky reds twice, so the budget
 * is raised once here instead of chasing per-test timeouts.
 */
export default defineConfig({
  test: {
    testTimeout: 20000,
  },
})
