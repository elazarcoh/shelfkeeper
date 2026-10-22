import translatorPrefix from '../../../../packages/domain/src/providers/fixtures/simania-translator-prefix.json'

export const SIMANIA_TEST_URL = 'https://simania.co.il'
export let simaniaFetches: string[] = []
export const resetSimaniaFetches = () => {
  simaniaFetches = []
}

/** A Simania book page built from the fixture capture; any other path is a redirect (refused by the client). */
export function simaniaFixtureFetch() {
  return (url: string): Promise<Response> => {
    simaniaFetches.push(url)
    if (url === 'https://simania.co.il/bookdetails.php?item_id=690482') {
      const ld = translatorPrefix.ld.map((n) => `<script type="application/ld+json">${JSON.stringify(n)}</script>`).join('')
      const meta = Object.entries(translatorPrefix.meta)
        .map(([k, v]) => `<meta property="${k}" content="${v.replace(/"/g, '&quot;')}">`)
        .join('')
      return Promise.resolve(new Response(`<html><head><title>${translatorPrefix.title}</title>${meta}${ld}</head><body></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } }))
    }
    return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://simania.co.il/' } }))
  }
}
