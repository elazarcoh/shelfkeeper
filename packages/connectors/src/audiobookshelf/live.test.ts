import { describe, expect, it } from 'vitest'
import { AudiobookshelfConfig, type ExternalItem } from '@mylib/domain'
import { createHttpClient } from '../http'
import { audiobookshelf } from './connector'

const baseUrl = process.env.ABS_URL
const apiToken = process.env.ABS_TOKEN

// Run with: ABS_URL=http://localhost:13378 ABS_TOKEN=... pnpm vitest run packages/connectors/src/audiobookshelf/live.test.ts
describe.skipIf(baseUrl === undefined || apiToken === undefined)('Audiobookshelf live smoke test', () => {
  it('connects and reads at least one book', async () => {
    const config = AudiobookshelfConfig.parse({ kind: 'audiobookshelf', baseUrl, apiToken })
    const http = createHttpClient()
    expect(await audiobookshelf.test(config, http)).toMatchObject({ ok: true })
    const items: ExternalItem[] = []
    for await (const r of audiobookshelf.fetchItems(config, http)) if (r.ok) items.push(r.value)
    expect(items.length).toBeGreaterThan(0)
  }, 120_000)
})
