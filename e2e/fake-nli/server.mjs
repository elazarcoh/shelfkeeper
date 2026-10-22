// A stand-in National Library of Israel search API for the e2e stack (#157): the recorded answer for one Hebrew book,
// found by its ISBN-13 or its record id; any other query finds nothing. A request without the key is refused.
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'

const dir = process.env.FIXTURES_DIR ?? '/fixtures'
const KEY = 'fake-nli-key-e2e'

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://fake-nli')
  if (url.pathname !== '/openlibrary/search' || url.searchParams.get('api_key') !== KEY) {
    res.writeHead(403)
    res.end()
    return
  }
  const query = url.searchParams.get('query')
  const body = query === 'any,contains,9789655310320' || query === 'any,contains,990026932820205171' ? await readFile(`${dir}/nli-isbn-hebrew.json`, 'utf8') : '[]'
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(body)
}).listen(80, () => console.log('fake-nli listening on :80'))
