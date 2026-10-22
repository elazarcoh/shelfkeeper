import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'worker',
    include: ['src/**/*.test.ts'],
    globalSetup: ['../../packages/db/src/testing/global-setup.ts'],
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
})
