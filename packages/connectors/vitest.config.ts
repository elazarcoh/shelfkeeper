import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'connectors', include: ['src/**/*.test.ts'] },
})
