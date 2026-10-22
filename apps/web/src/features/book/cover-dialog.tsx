import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Camera, ImageUp, RotateCcw, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState, type ClipboardEvent, type RefObject } from 'react'
import Cropper, { type Area } from 'react-easy-crop'
import { toast } from 'sonner'
import { returnFocusProps } from '@/components/dialog-focus'
import { DialogPanel } from '@/components/dialog-panel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { trpc, trpcClient } from '@/lib/trpc'
import { useInvalidateBook } from './invalidate'

// covers show at most a few hundred pixels wide; this keeps the upload small
const MAX_SIDE = 1200

const FRAMES = [
  { id: 'whole', label: 'Whole picture' },
  { id: 'book', label: 'Book 2:3' },
  { id: 'square', label: 'Square' },
] as const
type Frame = (typeof FRAMES)[number]['id']

/**
 * Draws the framed part of the picture, rotated, scaled down to fit MAX_SIDE, as JPEG (base64, no data: prefix).
 * The area is in pixels of the rotated picture's bounding box, as the cropper reports it.
 */
async function render(source: string, area: Area, rotation: number): Promise<string> {
  const img = new Image()
  img.src = source
  await img.decode()
  const w = img.naturalWidth
  const h = img.naturalHeight
  const rad = (rotation * Math.PI) / 180
  const boxW = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad))
  const boxH = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad))
  const scale = Math.min(1, MAX_SIDE / Math.max(area.width, area.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(area.width * scale))
  canvas.height = Math.max(1, Math.round(area.height * scale))
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('No canvas')
  // corners a tilted picture leaves bare come out white rather than black
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.scale(scale, scale)
  context.translate(-area.x + boxW / 2, -area.y + boxH / 2)
  context.rotate(rad)
  context.drawImage(img, -w / 2, -h / 2)
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1] ?? ''
}

/**
 * The browser reads the picture itself when the site allows it (CORS); otherwise the server downloads it for the page,
 * public internet only. Either way the address is never saved, only the shrunk picture.
 */
async function fromAddress(url: string): Promise<Blob> {
  try {
    const response = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (response.ok) return await response.blob()
  } catch {
    // blocked by CORS or unreachable from here: ask the server
  }
  const got = await trpcClient.catalog.fetchCoverUrl.mutate({ url })
  return new Blob([Uint8Array.from(atob(got.imageBase64), (c) => c.charCodeAt(0))], { type: got.mime })
}

/** Whose cover the dialog sets: a copy's, or (#161) a book still waiting in the Inbox, which gets it on Accept. */
export type CoverTarget = { kind: 'edition'; editionId: string } | { kind: 'proposal'; proposalId: string }

/** #100: set an edition's cover from a file, a pasted picture or a web address, framed, zoomed and rotated first. */
export function CoverDialog({
  target,
  open: controlledOpen,
  onOpenChange,
  returnFocusRef,
}: {
  target: CoverTarget
  /** controlled: opened from a ⋯ menu, which owns the trigger */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  returnFocusRef?: RefObject<HTMLElement | null>
}) {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlledOpen ?? ownOpen
  const setOpen = onOpenChange ?? setOwnOpen
  // an object URL of the chosen picture, local to this page; the cropper and the canvas both read it
  const [source, setSource] = useState<string | null>(null)
  const [natural, setNatural] = useState(1)
  const [frame, setFrame] = useState<Frame>('whole')
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [area, setArea] = useState<Area | null>(null)
  const [address, setAddress] = useState('')
  const [loading, setLoading] = useState(false)
  const [rendering, setRendering] = useState(false)
  const invalidate = useInvalidateBook()

  const camera = useRef<HTMLInputElement>(null)

  const pick = (file: Blob | null | undefined, startFrame?: Frame) => {
    if (file === null || file === undefined) return toast.error('That is not a picture')
    setSource(URL.createObjectURL(file))
    if (startFrame !== undefined) setFrame(startFrame)
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setRotation(0)
    setArea(null)
  }

  // the previous picture's object URL is let go once it is replaced or the dialog closes
  useEffect(() => () => {
    if (source !== null) URL.revokeObjectURL(source)
  }, [source])

  const load = () => {
    setLoading(true)
    fromAddress(address.trim())
      .then(pick, (e: unknown) => toast.error(e instanceof Error ? e.message : "The picture couldn't be downloaded"))
      .finally(() => setLoading(false))
  }

  // a reopened dialog starts empty
  useEffect(() => {
    if (!open) {
      setSource(null)
      setAddress('')
      setFrame('whole')
    }
  }, [open])

  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (imageBase64: string) =>
      target.kind === 'edition' ? trpcClient.catalog.uploadCover.mutate({ editionId: target.editionId, imageBase64 }) : trpcClient.shelf.setCover.mutate({ proposalId: target.proposalId, imageBase64 }),
    onSuccess: () => {
      if (target.kind === 'edition') invalidate()
      else void queryClient.invalidateQueries({ queryKey: trpc.inbox.pathKey() })
      toast.success(target.kind === 'edition' ? 'Cover set' : 'Cover photo saved')
      setOpen(false)
    },
    onError: (e) => toast.error(e.message),
  })

  const submit = () => {
    if (source === null || area === null) return
    setRendering(true)
    render(source, area, rotation)
      .then((imageBase64) => save.mutate(imageBase64), () => toast.error("That picture couldn't be read"))
      .finally(() => setRendering(false))
  }

  // the whole-picture frame follows the picture's shape, turned with it at a quarter turn
  const quarter = Math.abs(Math.round(rotation / 90)) % 2 === 1
  const aspect = frame === 'book' ? 2 / 3 : frame === 'square' ? 1 : quarter ? 1 / natural : natural
  const turn = (by: number) => setRotation((r) => ((r + by + 540) % 360) - 180)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {controlledOpen === undefined ? (
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <ImageUp className="size-4" /> Set cover
          </Button>
        </DialogTrigger>
      ) : null}
      {/* paste works anywhere in the open dialog */}
      <DialogContent bare className="sm:max-w-md" {...returnFocusProps(returnFocusRef)} onPaste={(e: ClipboardEvent) => pick([...e.clipboardData.files].find((f) => f.type.startsWith('image/')))}>
        <DialogPanel
          title={target.kind === 'edition' ? 'Set this edition’s cover' : 'Cover photo'}
          description={`Take a photo, choose a picture, paste one (Ctrl+V) or load it from a web address, then drag, zoom and turn it to frame the cover. ${target.kind === 'edition' ? 'It replaces the current cover.' : 'It becomes the cover when you add the book, instead of the linked page’s.'}`}
          footer={
            <Button disabled={source === null || area === null || rendering || save.isPending} onClick={submit}>
              {rendering || save.isPending ? 'Saving…' : 'Save cover'}
            </Button>
          }
        >
          <div className="flex flex-col items-center gap-3">
            <input type="file" accept="image/*" aria-label="Cover picture" className="text-sm" onChange={(e) => pick(e.target.files?.[0])} />
            {/* phones only: `capture` opens the back camera; a photo of a cover starts on the book frame, to trim the table around it */}
            <input
              ref={camera}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              aria-label="Cover photo"
              onChange={(e) => {
                pick(e.target.files?.[0], 'book')
                // empty again, so a retake of the same shot still counts as a change
                e.target.value = ''
              }}
            />
            <Button type="button" variant="outline" className="hidden pointer-coarse:inline-flex" onClick={() => camera.current?.click()}>
              <Camera className="size-4" /> Take a photo
            </Button>
            <div className="flex w-full gap-2">
              <Input
                type="url"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && address.trim() !== '' && load()}
                placeholder="https://… picture address"
                aria-label="Picture address"
                dir="ltr"
              />
              <Button variant="outline" disabled={address.trim() === '' || loading} onClick={load}>
                {loading ? 'Loading…' : 'Load'}
              </Button>
            </div>
            {source !== null ? (
              <>
                <div className="relative h-72 w-full overflow-hidden rounded-sm bg-muted" data-testid="cover-crop">
                  <Cropper
                    image={source}
                    crop={crop}
                    zoom={zoom}
                    rotation={rotation}
                    aspect={aspect}
                    onCropChange={setCrop}
                    onZoomChange={setZoom}
                    onRotationChange={setRotation}
                    onCropComplete={(_, pixels) => setArea(pixels)}
                    onMediaLoaded={(m) => setNatural(m.naturalWidth / m.naturalHeight)}
                    maxZoom={5}
                  />
                </div>
                <div className="flex flex-wrap justify-center gap-1" role="group" aria-label="Frame">
                  {FRAMES.map((f) => (
                    <Button key={f.id} size="sm" variant={frame === f.id ? 'default' : 'outline'} aria-pressed={frame === f.id} onClick={() => setFrame(f.id)}>
                      {f.label}
                    </Button>
                  ))}
                </div>
                <label className="flex w-full items-center gap-2 text-sm">
                  <span className="w-14 shrink-0">Zoom</span>
                  <input type="range" className="w-full" min={1} max={5} step={0.01} value={zoom} aria-label="Zoom" onChange={(e) => setZoom(Number(e.target.value))} />
                </label>
                <div className="flex w-full items-center gap-2 text-sm">
                  <span className="w-14 shrink-0">Turn</span>
                  <Button size="icon" variant="ghost" aria-label="Turn left a quarter" onClick={() => turn(-90)}>
                    <RotateCcw className="size-4" />
                  </Button>
                  <input type="range" className="w-full" min={-180} max={180} step={1} value={rotation} aria-label="Turn" onChange={(e) => setRotation(Number(e.target.value))} />
                  <Button size="icon" variant="ghost" aria-label="Turn right a quarter" onClick={() => turn(90)}>
                    <RotateCw className="size-4" />
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </DialogPanel>
      </DialogContent>
    </Dialog>
  )
}
