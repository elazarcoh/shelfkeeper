import { isbnFromBarcode } from '@mylib/domain'
// served by the app itself, not a CDN: the fallback decoder's binary (about 1 MB, loaded only when needed)
import zxingWasm from 'zxing-wasm/reader/zxing_reader.wasm?url'

interface Detector {
  detect(source: ImageBitmapSource): Promise<{ rawValue: string }[]>
}
interface DetectorClass {
  new (options: { formats: string[] }): Detector
  getSupportedFormats(): Promise<string[]>
}

let detector: Promise<Detector> | null = null

/** The phone's own barcode reader (Android Chrome), else the bundled one (iPhone, desktop); made once. */
export function barcodeDetector(): Promise<Detector> {
  detector ??= (async () => {
    const native = (globalThis as { BarcodeDetector?: DetectorClass }).BarcodeDetector
    if (native !== undefined && (await native.getSupportedFormats().catch((): string[] => [])).includes('ean_13')) return new native({ formats: ['ean_13'] })
    const { BarcodeDetector, prepareZXingModule } = await import('barcode-detector/ponyfill')
    prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? zxingWasm : prefix + path) } })
    return new BarcodeDetector({ formats: ['ean_13'] })
  })()
  // a failed start (no network for the decoder) is tried again next time
  detector.catch(() => {
    detector = null
  })
  return detector
}

export type Reading = { kind: 'isbn'; isbn: string } | { kind: 'other' } | { kind: 'none' }

/** What one picture (a camera frame or a photo) shows: an ISBN barcode, another barcode (a price code), or none. */
export async function readBarcode(source: ImageBitmapSource): Promise<Reading> {
  const found = await (await barcodeDetector()).detect(source)
  for (const code of found) {
    const isbn = isbnFromBarcode(code.rawValue)
    if (isbn !== null) return { kind: 'isbn', isbn }
  }
  return found.length > 0 ? { kind: 'other' } : { kind: 'none' }
}
