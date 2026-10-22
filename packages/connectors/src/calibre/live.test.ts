import { describe, expect, it } from 'vitest'
import { CalibreConfig, type ExternalItem } from '@mylib/domain'
import { createHttpClient } from '../http'
import { calibre } from './connector'

const baseUrl = process.env.CALIBRE_URL

// Run with: CALIBRE_URL=http://localhost:18083 [CALIBRE_USER=… CALIBRE_PASSWORD=…] [CALIBRE_WORDS=#words] pnpm vitest run packages/connectors/src/calibre/live.test.ts
describe.skipIf(baseUrl === undefined)('Calibre live smoke test', () => {
  it('connects and reads at least one book', async () => {
    const config = CalibreConfig.parse({
      kind: 'calibre',
      baseUrl,
      username: process.env.CALIBRE_USER ?? null,
      password: process.env.CALIBRE_PASSWORD ?? null,
      wordCountColumn: process.env.CALIBRE_WORDS ?? null,
    })
    const http = createHttpClient()
    expect(await calibre.test(config, http)).toMatchObject({ ok: true })
    const items: ExternalItem[] = []
    for await (const r of calibre.fetchItems(config, http)) if (r.ok) items.push(r.value)
    expect(items.length).toBeGreaterThan(0)
    const cover = items.find((i) => i.coverUrl !== null)
    if (cover?.coverUrl) expect((await calibre.fetchCover(config, http, cover.coverUrl)).ok).toBe(true)
  }, 120_000)
})
