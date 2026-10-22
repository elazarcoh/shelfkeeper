import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'jobs',
    include: ['src/**/*.test.ts'],
    globalSetup: ['../db/src/testing/global-setup.ts'],
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
})
