import type { Connector } from '@mylib/connectors'
import { err, ExternalItem, ok } from '@mylib/domain'

export const CRASH_ITEMS = Array.from({ length: 6 }, (_, i) =>
  ExternalItem.parse({ externalId: `li_crash_${i}`, format: 'audiobook', title: `Crash Book ${i}`, authors: ['Test Author'], durationSec: 3600 + i }),
)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** A source that hands out CRASH_ITEMS one by one, `delayMs` apart, and has no covers. */
export function slowConnector(delayMs: number): Connector {
  return {
    kind: 'audiobookshelf',
    test: () => Promise.resolve(ok({ libraries: [] })),
    fetchItems: async function* () {
      for (const item of CRASH_ITEMS) {
        await sleep(delayMs)
        yield ok(item)
      }
    },
    fetchCover: () => Promise.resolve(err({ kind: 'provider_error', message: 'no covers here' })),
  }
}

/** A source whose covers arrive `delayMs` apart: a PNG unique to each URL. */
export function coverConnector(delayMs: number): Connector {
  return {
    ...slowConnector(0),
    fetchCover: async (_config, _http, url) => {
      await sleep(delayMs)
      return ok(Uint8Array.from([...PNG, ...new TextEncoder().encode(url)]))
    },
  }
}
