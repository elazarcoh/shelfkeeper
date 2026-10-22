import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useEffect, useMemo, useState, type RefObject } from 'react'
import { toast } from 'sonner'
import type { ExtractedPage, MetadataSource, PageCapture } from '@mylib/domain'
import { returnFocusProps } from '@/components/dialog-focus'
import { DialogPanel } from '@/components/dialog-panel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { BookLinker, type HardcoverPick } from '@/features/shelf/book-linker'
import { trpc, trpcClient, type RouterOutputs } from '@/lib/trpc'
import { useBookCapture } from './capture-router'
import type { EditionDetail } from './edition-form-state'
import { copyForPage, metadataRows, patchesFor, type MetaField, type MetaRow, type MetaScope } from './fetch-metadata-state'
import { useInvalidateBook } from './invalidate'
import { KeepStep } from './keep-step'

type WorkDetail = RouterOutputs['catalog']['get']

const message = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong')

/**
 * Finds the book on Hardcover, Open Library or Simania (one page per press, never in the background) and shows, field by
 * field, what that page would change. Only the fields the person ticks are saved; those the book already has start unticked.
 * A Hardcover page also links the book to Hardcover. Given a copy (its card's button), it looks that copy up, by its ISBN
 * first, and offers only that copy's fields.
 */
export function FetchMetadataDialog({
  work,
  copy,
  open: controlledOpen,
  onOpenChange,
  returnFocusRef,
  initialSource,
}: {
  work: WorkDetail
  copy?: EditionDetail
  /** controlled: opened from a ⋯ menu, which owns the trigger */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  returnFocusRef?: RefObject<HTMLElement | null>
  /** the tab step 1 opens on (Hardcover only counts when the household has a token) */
  initialSource?: MetadataSource
}) {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlledOpen ?? ownOpen
  const setOpen = onOpenChange ?? setOwnOpen
  const [page, setPage] = useState<ExtractedPage | null>(null)
  const [editionId, setEditionId] = useState<string | null>(null)
  const [ticked, setTicked] = useState<Set<MetaField>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const invalidate = useInvalidateBook()
  const queryClient = useQueryClient()
  const forWork = useQuery(trpc.hardcover.forWork.queryOptions({ workId: work.id }))
  const hardcoverEnabled = forWork.data?.enabled === true
  const view = forWork.data?.view ?? null
  const currentId = view !== null && view.match !== 'none' && view.match !== 'rejected' ? view.hardcoverId : null
  // the bridge to the Open Library original is only asked for while step 1 is showing
  const suggestion = useQuery({ ...trpc.hardcover.suggestQuery.queryOptions({ workId: work.id }), enabled: open && hardcoverEnabled && page === null && copy === undefined })
  const scope: MetaScope = copy === undefined ? 'book' : 'edition'

  // a toast from before (e.g. "Book added") must not cover the dialog
  useEffect(() => {
    if (open) toast.dismiss()
  }, [open])

  const pickEdition = (id: string | null) => (copy !== undefined ? copy : (work.editions.find((e) => e.id === id) ?? null))
  const edition = pickEdition(editionId)
  const rows = useMemo(() => (page === null ? [] : metadataRows(work, edition, page, scope)), [work, edition, page, scope])

  // a page found in step 1: the copy it belongs to (a copy's own dialog keeps its copy) and what starts ticked
  const show = (found: ExtractedPage) => {
    const id = copy !== undefined ? copy.id : copyForPage(work, found)
    setPage(found)
    setEditionId(id)
    setError(null)
    setTicked(new Set(metadataRows(work, pickEdition(id), found, scope).filter((r) => r.checked).map((r) => r.field)))
  }

  const read = useMutation({
    mutationFn: (capture: PageCapture) => trpcClient.shelf.extract.mutate({ capture }),
    onSuccess: (extracted) => {
      show(extracted)
      setOpen(true)
    },
  })

  // a page sent back by the bookmarklet from the Simania tab this dialog opened (or by its #capture= fallback); a dialog opened
  // on a chosen tab (from the Hardcover section) listens only while open, so it never shadows the ⋯ menu's own
  useBookCapture(copy === undefined ? 'work' : `edition:${copy.id}`, (capture) => read.mutate(capture, { onError: (e) => setError(message(e)) }), initialSource === undefined || open)

  const onlyLink = page !== null && page.provider === 'hardcover' && !rows.some((r) => ticked.has(r.field))
  const apply = useMutation({
    mutationFn: async () => {
      if (page === null) return
      const patches = patchesFor(work, page, rows, ticked)
      // link first, so a failed field or cover download still leaves the book linked
      if (page.provider === 'hardcover') await trpcClient.hardcover.link.mutate({ workId: work.id, hardcoverId: Number(page.providerId) })
      if (patches.work !== null) await trpcClient.catalog.update.mutate({ workId: work.id, patch: patches.work })
      if (edition !== null && patches.edition !== null) await trpcClient.catalog.updateEdition.mutate({ editionId: edition.id, patch: patches.edition })
      if (edition !== null && patches.coverUrl !== null) await trpcClient.catalog.setCoverFromPage.mutate({ editionId: edition.id, coverUrl: patches.coverUrl })
    },
    onSuccess: () => {
      toast.success(onlyLink ? 'Linked to Hardcover' : 'Saved')
      setOpen(false)
      setPage(null)
    },
    onMutate: () => setError(null),
    // inline under the footer: a toast would sit on top of the dialog
    onError: (e) => setError(message(e)),
    // a partial save (the cover failed after the fields were saved) still shows what was saved
    onSettled: () => {
      invalidate()
      void queryClient.invalidateQueries({ queryKey: trpc.hardcover.forWork.queryKey({ workId: work.id }) })
    },
  })

  const chooseEdition = (id: string) => {
    setEditionId(id)
    if (page === null) return
    setTicked(new Set(metadataRows(work, pickEdition(id), page, scope).filter((r) => r.checked).map((r) => r.field)))
  }
  const toggle = (field: MetaField, on: boolean) =>
    setTicked((t) => {
      const next = new Set(t)
      if (on) next.add(field)
      else next.delete(field)
      return next
    })
  const setAll = (group: MetaRow[], on: boolean) =>
    setTicked((t) => {
      const next = new Set(t)
      for (const r of group) {
        if (on) next.add(r.field)
        else next.delete(r.field)
      }
      return next
    })
  const ownSeries = work.series[0]?.name ?? null

  const pickHardcover = async (pick: HardcoverPick) => {
    show('page' in pick ? pick.page : await trpcClient.hardcover.page.mutate({ hardcoverId: pick.hardcoverId, editionId: pick.editionId }))
  }
  // "Not this book": never auto-matched again; it happens on press and needs no Keep
  const unlink = async () => {
    await trpcClient.hardcover.reject.mutate({ workId: work.id })
    await queryClient.invalidateQueries({ queryKey: trpc.hardcover.forWork.queryKey({ workId: work.id }) })
  }
  const bookScope = copy === undefined

  return (
    <>
      {controlledOpen === undefined ? (
        <Button variant="outline" size="sm" aria-label={copy === undefined ? undefined : 'Fetch metadata for this copy'} onClick={() => setOpen(true)}>
          <Download className="size-4" /> Fetch metadata
        </Button>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) {
            setPage(null)
            setError(null)
          }
        }}
      >
        <DialogContent bare className="sm:max-w-xl" {...returnFocusProps(returnFocusRef)}>
          {page === null ? (
            <DialogPanel
              title="Fetch metadata"
              footer={
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              }
            >
              <BookLinker
                idPrefix={copy === undefined ? `fetch-${work.id}` : `fetch-${copy.id}`}
                seed={{
                  title: copy?.displayTitle ?? work.title,
                  subtitle: work.subtitle,
                  series: ownSeries,
                  authors: work.authors.map((a) => a.creditedName),
                  spineText: null,
                  language: copy?.language ?? edition?.language ?? null,
                  isbn: copy === undefined ? null : (copy.isbn13 ?? copy.isbn10),
                }}
                target={copy === undefined ? { kind: 'work', id: work.id } : { kind: 'edition', id: copy.id }}
                onCapture={(capture) => read.mutateAsync(capture)}
                {...(initialSource !== undefined && (initialSource !== 'hardcover' || hardcoverEnabled) ? { initialSource } : {})}
                {...(hardcoverEnabled
                  ? {
                      hardcover: {
                        ...(suggestion.data !== undefined ? { query: suggestion.data.query } : {}),
                        current: bookScope && currentId !== null ? { hardcoverId: currentId, slug: view?.slug ?? null } : null,
                        ...(bookScope && currentId !== null ? { onUnlink: unlink } : {}),
                        onPick: pickHardcover,
                      },
                    }
                  : {})}
              />
              {error !== null ? (
                <p role="alert" dir="auto" className="mt-2 text-sm text-destructive wrap-anywhere">
                  {error}
                </p>
              ) : null}
            </DialogPanel>
          ) : (
            <KeepStep
              work={work}
              page={page}
              rows={rows}
              ticked={ticked}
              onToggle={toggle}
              onSetAll={setAll}
              currentHardcoverId={currentId}
              editionId={edition?.id ?? null}
              onChooseEdition={chooseEdition}
              scopedToCopy={copy !== undefined}
              pending={apply.isPending}
              error={error}
              onBack={() => {
                setPage(null)
                setError(null)
              }}
              onKeep={() => apply.mutate()}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
