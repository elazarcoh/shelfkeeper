import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'db',
    include: ['src/**/*.test.ts'],
    globalSetup: ['src/testing/global-setup.ts'],
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
})
