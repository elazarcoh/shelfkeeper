export type ImageKind = { mime: 'image/jpeg'; ext: 'jpg' } | { mime: 'image/png'; ext: 'png' } | { mime: 'image/webp'; ext: 'webp' } | { mime: 'image/gif'; ext: 'gif' }

/** Covers larger than this are not stored (plan deviation 13). */
export const MAX_COVER_BYTES = 10 * 1024 * 1024

const starts = (bytes: Uint8Array, at: number, ...expected: number[]) => expected.every((b, i) => bytes[at + i] === b)

/** What an image really is, by its magic bytes — never by the server's content-type. SVG is refused (it can carry script). */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (starts(bytes, 0, 0xff, 0xd8, 0xff)) return { mime: 'image/jpeg', ext: 'jpg' }
  if (starts(bytes, 0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mime: 'image/png', ext: 'png' }
  if (starts(bytes, 0, 0x47, 0x49, 0x46, 0x38)) return { mime: 'image/gif', ext: 'gif' }
  if (starts(bytes, 0, 0x52, 0x49, 0x46, 0x46) && starts(bytes, 8, 0x57, 0x45, 0x42, 0x50)) return { mime: 'image/webp', ext: 'webp' }
  return null
}
