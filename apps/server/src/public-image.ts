import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { err, MAX_COVER_BYTES, ok, sniffImage, type ImageKind, type Result } from '@mylib/domain'

/** Downloads a picture from a URL someone typed (#100). Never stores or logs the URL. */
export type ImageFetcher = (url: string) => Promise<Result<{ bytes: Uint8Array; kind: ImageKind }, string>>

const TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 3

// Everything that isn't the public internet: this server, the LAN, link-local, carrier NAT, multicast, reserved,
// and the IPv6 forms that can wrap one of those (mapped, NAT64, 6to4).
const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
  ['::', 127], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, prefix, 'ipv6')

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  // IPv4-mapped (::ffff:a.b.c.d): a BlockList rule for it would match every IPv4 address, so refuse these outright
  if (family === 6 && /^::ffff:/i.test(address)) return false
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

/** http(s) on the default port, no credentials, and a host name or public IP literal. */
export function checkImageUrl(raw: string, base?: URL): URL | null {
  let url: URL
  try {
    url = new URL(raw, base)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.port !== '' || url.username !== '' || url.password !== '') return null
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) !== 0 && !isPublicAddress(host)) return null
  if (isIP(host) === 0 && (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.'))) return null
  return url
}

// The check happens on the address actually connected to, so a name that resolves (or re-resolves) to a LAN address fails.
const publicLookup = ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error)
    const first = addresses[0]
    if (first === undefined || addresses.some((a) => !isPublicAddress(a.address))) return callback(new Error('not a public address'))
    if (options.all === true) callback(null, addresses)
    else callback(null, first.address, first.family)
  })
}) as unknown as LookupFunction

function get(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET',
      lookup: publicLookup,
      signal,
      headers: { accept: 'image/*', 'user-agent': 'my-library' },
    })
    request.on('response', resolve)
    request.on('error', reject)
    request.end()
  })
}

async function readLimited(response: IncomingMessage, maxBytes: number): Promise<Uint8Array | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response) {
    total += (chunk as Buffer).byteLength
    if (total > maxBytes) {
      response.destroy()
      return null
    }
    chunks.push(chunk as Buffer)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

export function createImageFetcher(maxBytes = MAX_COVER_BYTES): ImageFetcher {
  return async (raw) => {
    let url = checkImageUrl(raw)
    if (url === null) return err('Use a web address (http or https) of a picture on the internet')
    const signal = AbortSignal.timeout(TIMEOUT_MS)
    try {
      for (let hop = 0; ; hop++) {
        const response = await get(url, signal)
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400 && response.headers.location !== undefined) {
          response.resume()
          const next = checkImageUrl(response.headers.location, url)
          if (next === null || hop >= MAX_REDIRECTS) return err('That address redirects somewhere it may not go')
          url = next
          continue
        }
        if (status !== 200) {
          response.resume()
          return err(`The site answered ${status} — check the address`)
        }
        if (Number(response.headers['content-length'] ?? 0) > maxBytes) {
          response.destroy()
          return err('That picture is too big')
        }
        const bytes = await readLimited(response, maxBytes)
        if (bytes === null) return err('That picture is too big')
        const kind = sniffImage(bytes)
        return kind === null ? err('That address is not a JPEG, PNG, GIF or WebP picture') : ok({ bytes, kind })
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'not a public address') return err('That address is not on the public internet')
      return err("The picture couldn't be downloaded — check the address")
    }
  }
}
