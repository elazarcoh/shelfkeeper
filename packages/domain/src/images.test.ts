import { describe, expect, it } from 'vitest'
import { sniffImage } from './images'

const bytes = (...b: number[]) => new Uint8Array([...b, 0, 0, 0, 0, 0, 0, 0, 0])
// the domain package has no DOM or Node types, so no TextEncoder
const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0))

describe('sniffImage', () => {
  it('recognises JPEG, PNG, GIF and WebP by their magic bytes', () => {
    expect(sniffImage(bytes(0xff, 0xd8, 0xff))).toEqual({ mime: 'image/jpeg', ext: 'jpg' })
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({ mime: 'image/png', ext: 'png' })
    expect(sniffImage(bytes(0x47, 0x49, 0x46, 0x38))).toEqual({ mime: 'image/gif', ext: 'gif' })
    expect(sniffImage(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toEqual({ mime: 'image/webp', ext: 'webp' })
  })
  it('rejects anything else (an HTML error page, SVG)', () => {
    expect(sniffImage(ascii('<!doctype html><html>'))).toBeNull()
    expect(sniffImage(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
  })
})
