import { describe, expect, it } from 'vitest'
import { ReadarrConfig, ChaptarrConfig, type ExternalItem } from '@mylib/domain'
import { createHttpClient } from '../http'
import { createArrConnector } from './connector'

const baseUrl = process.env.ARR_URL
const apiKey = process.env.ARR_KEY
const kind = process.env.ARR_KIND === 'chaptarr' ? 'chaptarr' : 'readarr'

// Run with: ARR_KIND=readarr|chaptarr ARR_URL=http://localhost:8787 ARR_KEY=… pnpm vitest run packages/connectors/src/arr/live.test.ts
describe.skipIf(baseUrl === undefined || apiKey === undefined)(`${kind} live smoke test`, () => {
  it('connects and reads its books (files and wanted)', async () => {
    const config = kind === 'chaptarr'
      ? ChaptarrConfig.parse({ kind, baseUrl, apiKey })
      : ReadarrConfig.parse({ kind, baseUrl, apiKey })
    const connector = createArrConnector(config.kind)
    const http = createHttpClient()
    expect(await connector.test(config, http)).toMatchObject({ ok: true })
    const items: ExternalItem[] = []
    for await (const r of connector.fetchItems(config, http)) if (r.ok) items.push(r.value)
    expect(items.length).toBeGreaterThan(0)
  }, 120_000)
})
