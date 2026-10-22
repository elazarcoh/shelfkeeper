import { ImageUp } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { isbnForms } from '@mylib/domain'
import { DialogPanel } from '@/components/dialog-panel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { readBarcode, type Reading } from './barcode'

// a few looks a second: enough to catch a barcode held still, light on an old phone's battery
const LOOK_EVERY_MS = 250

type Status = 'starting' | 'looking' | 'other' | 'no_camera' | 'reading_photo' | 'photo_none' | 'photo_other' | 'failed'
const STATUS: Record<Status, string> = {
  starting: 'Opening the camera…',
  looking: 'Looking for the barcode…',
  other: "That's another barcode — find the one whose number starts with 978",
  no_camera: "The camera didn't open — take a photo of the barcode or type the ISBN",
  reading_photo: 'Reading the photo…',
  photo_none: 'No barcode in that photo — try again closer, with the barcode flat and sharp',
  photo_other: "That photo shows another barcode — photograph the one whose number starts with 978",
  failed: "The barcode reader didn't start — type the ISBN instead",
}

/**
 * #157: reads a book's ISBN barcode with the camera (or from a photo, or typed) and hands the ISBN-13 on.
 * Nothing leaves the phone here: the picture is read on the device, only the number goes on.
 */
export function BarcodeScanner({ open, onOpenChange, onIsbn }: { open: boolean; onOpenChange: (open: boolean) => void; onIsbn: (isbn: string) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const photo = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<Status>('starting')
  const [typed, setTyped] = useState('')
  const typedIsbn = isbnForms(typed)?.isbn13 ?? null

  const done = (isbn: string) => {
    onOpenChange(false)
    onIsbn(isbn)
  }

  useEffect(() => {
    if (!open) return
    // changed by the callbacks below and the cleanup, so kept in one object
    const run: { stream: MediaStream | null; timer: number | undefined; stopped: boolean; busy: boolean } = { stream: null, timer: undefined, stopped: false, busy: false }
    setStatus('starting')
    setTyped('')
    void (async () => {
      try {
        // plain http (or an old browser) has no camera API at all
        if (!('mediaDevices' in navigator)) throw new Error('no camera')
        run.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      } catch {
        if (!run.stopped) setStatus('no_camera')
        return
      }
      const v = video.current
      if (run.stopped || v === null) {
        run.stream.getTracks().forEach((t) => t.stop())
        return
      }
      v.srcObject = run.stream
      await v.play().catch(() => undefined)
      setStatus('looking')
      run.timer = window.setInterval(() => {
        if (run.busy || run.stopped || v.readyState < 2) return
        run.busy = true
        readBarcode(v)
          .then((reading) => {
            if (run.stopped) return
            if (reading.kind === 'isbn') {
              run.stopped = true
              done(reading.isbn)
            } else setStatus(reading.kind === 'other' ? 'other' : 'looking')
          })
          .catch(() => {
            if (!run.stopped) setStatus('failed')
          })
          .finally(() => {
            run.busy = false
          })
      }, LOOK_EVERY_MS)
    })()
    return () => {
      run.stopped = true
      window.clearInterval(run.timer)
      run.stream?.getTracks().forEach((t) => t.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per opening; `done` only closes and hands on
  }, [open])

  async function readPhoto(file: File | undefined) {
    if (file === undefined) return
    setStatus('reading_photo')
    let reading: Reading
    try {
      reading = await readBarcode(await createImageBitmap(file))
    } catch {
      setStatus('failed')
      return
    }
    if (reading.kind === 'isbn') done(reading.isbn)
    else setStatus(reading.kind === 'other' ? 'photo_other' : 'photo_none')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent bare className="sm:max-w-md">
        <DialogPanel
          title="Scan a barcode"
          description="Point the camera at the barcode on the back cover: the one whose number starts with 978."
          footer={
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          }
        >
          <div className="grid gap-3">
            {status !== 'no_camera' ? <video ref={video} muted playsInline aria-label="Camera" className="aspect-[4/3] w-full rounded-md bg-black object-cover" /> : null}
            <p role="status" className="text-sm text-muted-foreground">
              {STATUS[status]}
            </p>
            <input
              ref={photo}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              aria-label="Barcode photo"
              onChange={(e) => {
                void readPhoto(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            <div>
              <Button type="button" variant="outline" onClick={() => photo.current?.click()}>
                <ImageUp /> Use a photo
              </Button>
            </div>
            <form
              className="grid gap-1.5 border-t pt-3"
              onSubmit={(e) => {
                e.preventDefault()
                // a React submit bubbles out of the portal: the dialog this opened from may be a form itself
                e.stopPropagation()
                if (typedIsbn !== null) done(typedIsbn)
              }}
            >
              <Label htmlFor="scan-isbn">Or type the ISBN</Label>
              <div className="flex gap-2">
                <Input id="scan-isbn" dir="ltr" inputMode="numeric" autoComplete="off" placeholder="978…" value={typed} onChange={(e) => setTyped(e.target.value)} />
                <Button type="submit" disabled={typedIsbn === null}>
                  Look up
                </Button>
              </div>
              {typed.trim() !== '' && typedIsbn === null ? <p className="text-xs text-muted-foreground">An ISBN has 10 or 13 digits</p> : null}
            </form>
          </div>
        </DialogPanel>
      </DialogContent>
    </Dialog>
  )
}
