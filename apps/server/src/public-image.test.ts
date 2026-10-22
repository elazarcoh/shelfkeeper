import { describe, expect, it } from 'vitest'
import { checkImageUrl, createImageFetcher, isPublicAddress } from './public-image'

describe('cover from an address (#100): public internet only', () => {
  it('tells public addresses from this server, the LAN and the special ranges', () => {
    for (const ip of ['8.8.8.8', '151.101.1.1', '2606:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true)
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:192.168.1.10', '64:ff9b::a00:1', 'not-an-ip']) {
      expect(isPublicAddress(ip), ip).toBe(false)
    }
  })

  it('accepts only http(s) on the default port to a public host', () => {
    expect(checkImageUrl('https://covers.example.com/a.jpg')?.hostname).toBe('covers.example.com')
    expect(checkImageUrl('/b.png', new URL('https://x.example.com/a'))?.href).toBe('https://x.example.com/b.png')
    for (const bad of ['ftp://x.example.com/a.jpg', 'file:///etc/passwd', 'https://x.example.com:8080/a.jpg', 'https://u:p@x.example.com/a.jpg', 'http://localhost/a.png', 'http://pi/a.png', 'http://192.168.1.10/a.png', 'http://[::1]/a.png', 'http://2130706433/a.png', 'nonsense']) {
      expect(checkImageUrl(bad), bad).toBeNull()
    }
  })

  it('refuses before connecting, and when a name resolves to a private address', async () => {
    const fetchImage = createImageFetcher()
    expect(await fetchImage('http://127.0.0.1/a.png')).toEqual({ ok: false, error: 'Use a web address (http or https) of a picture on the internet' })
    // localtest.me style names are not needed: the hosts file maps this one to 127.0.0.1 with no network
    expect(await fetchImage('http://foo.localhost/a.png')).toMatchObject({ ok: false })
  })
})
