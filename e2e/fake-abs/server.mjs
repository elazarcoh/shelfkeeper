// A stand-in Audiobookshelf for the e2e stack: serves the connector's recorded fixtures, and takes metadata writes
// (PATCH /api/items/:id/media) in memory so a spec can send and read back. /__patches and /__reset need no auth.
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'

const dir = process.env.FIXTURES_DIR ?? '/fixtures'
const TOKEN = 'fixture-token'
const itemFiles = { li_mistborn: 'li_mistborn.json', li_hp1: 'li_hp1.json' }

const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

// per item id: metadata written by PATCH, merged over the fixture on every read
const overrides = new Map()
let patches = []

const readItem = async (id) => {
  const file = itemFiles[id]
  if (!file) return undefined
  const item = JSON.parse(await readFile(`${dir}/${file}`, 'utf8'))
  const over = overrides.get(id)
  if (over) item.media = { ...item.media, metadata: { ...item.media.metadata, ...over } }
  return item
}
const readBody = async (req) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://fake-abs')
  if (url.pathname === '/__patches' && req.method === 'GET') return json(res, patches)
  if (url.pathname === '/__reset' && req.method === 'POST') {
    overrides.clear()
    patches = []
    return json(res, { ok: true })
  }
  const media = req.method === 'PATCH' ? /^\/api\/items\/([^/]+)\/media$/.exec(url.pathname) : null
  if (media) {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end('Unauthorized')
    const id = decodeURIComponent(media[1])
    if (!itemFiles[id]) return void res.writeHead(404).end('Not found')
    let body
    try {
      body = await readBody(req)
    } catch {
      return void res.writeHead(400).end('Bad JSON')
    }
    patches.push({ id, body })
    // ABS gives new authors and series an id of their own
    const metadata = { ...body.metadata }
    if (metadata.authors) metadata.authors = metadata.authors.map((a) => ({ id: `aut_${a.name}`, ...a }))
    if (metadata.series) metadata.series = metadata.series.map((x) => ({ id: `ser_${x.name}`, ...x }))
    overrides.set(id, { ...overrides.get(id), ...metadata })
    return json(res, { updated: true, libraryItem: await readItem(id) })
  }
  if (req.method !== 'GET') return void res.writeHead(405).end()
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end('Unauthorized')
  if (url.pathname === '/api/libraries') return json(res, await readFile(`${dir}/libraries.json`, 'utf8'))
  if (url.pathname === '/api/libraries/lib_books/items') {
    if (url.searchParams.get('page') === '0') return json(res, await readFile(`${dir}/items-page-0.json`, 'utf8'))
    return json(res, { results: [], total: 3, limit: 100, page: Number(url.searchParams.get('page')) })
  }
  if (url.pathname === '/api/libraries/lib_pods/items') return json(res, { results: [], total: 0, limit: 100, page: 0 })
  if (/^\/api\/items\/[^/]+\/cover$/.test(url.pathname)) {
    // a 1×1 PNG, the same bytes as COVER_PNG in @mylib/connectors/testing
    res.writeHead(200, { 'content-type': 'image/png' })
    return void res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  }
  const match = /^\/api\/items\/([^/]+)$/.exec(url.pathname)
  const item = match ? await readItem(decodeURIComponent(match[1])) : undefined
  if (item) return json(res, item)
  res.writeHead(404).end('Not found')
}).listen(80, () => console.log('fake-abs listening on :80'))
