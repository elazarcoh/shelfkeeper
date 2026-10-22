import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { parseShelfAnswer, SHELF_FORMAT, SHELF_PROMPT, SHELF_SETUP_PROMPT, shelfAnswerFormat, type ExtractedPage, type PageCapture } from '@mylib/domain'
import { PageBody, PageHeader, PageSections } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { newImportId } from '@/features/csv/csv-import-state'
import { invalidateWishes } from '@/features/wishlist/wish-dialog'
import { emptyDraft, fieldsFromDraft, type WishDraft } from '@/features/wishlist/wish-form-state'
import { copyText } from '@/lib/copy-text'
import { todayLocal } from '@/lib/format'
import { trpc, trpcClient } from '@/lib/trpc'
import { BookmarkletSetup } from './bookmarklet-setup'
import { BookLinker } from './book-linker'
import { takeTarget } from './capture-target'
import type { SingleOwnership } from './ownership-picker'
import { ReviewList } from './review-list'
import { sharedFromSearch } from './share-target'
import { applyStatuses, batchLabel, editRow, importRows, rowFromExtracted, rowsFromAnswer, rowWithVolume, setCapture, setPreset, settleStatuses, toggle, type ReviewRow } from './shelf-state'
import { addTarget, existingWishDraft, pickMaybe, SingleBookReview, wishTarget, type SingleBook } from './single-book'
import { useCapture } from './use-capture'
import { fieldsFromVolume, volumeFromFields, type VolumeText } from './volume-fields'

const message = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong')

const NO_SEED = { title: '', subtitle: null, series: null, authors: [], spineText: null, language: null }

export function ShelfPage({ userId }: { userId: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const promptArea = useRef<HTMLTextAreaElement>(null)
  const promptDetails = useRef<HTMLDetailsElement>(null)
  const setupArea = useRef<HTMLTextAreaElement>(null)
  const setupDetails = useRef<HTMLDetailsElement>(null)
  const [answer, setAnswer] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)
  const [notes, setNotes] = useState<{ unreadable: { position: number; reason: string }[]; truncated: boolean; outdated: boolean } | null>(null)
  const [rows, setRows] = useState<ReviewRow[]>([])
  const [linked, setLinked] = useState<Record<string, ExtractedPage>>({})
  /** made once when the list is read: a retry of the import sends the same id */
  const [batchId, setBatchId] = useState<string | null>(null)
  const [ownership, setOwnership] = useState<SingleOwnership>('owned')
  const [borrowedFrom, setBorrowedFrom] = useState('')
  const [single, setSingle] = useState<SingleBook | null>(null)
  const [wishDraft, setWishDraft] = useState<WishDraft>(() => emptyDraft())
  /** the single book's volume as typed; `volumeEdited` once the person changed it (then it wins over the page's) */
  const [volumeText, setVolumeText] = useState<VolumeText>({ volume: '', count: '' })
  const [volumeEdited, setVolumeEdited] = useState(false)
  const singleId = single?.batchId ?? null
  const singlePage = single?.page ?? null
  const singleCapture = single?.capture ?? null
  // an edited volume re-runs the duplicate check with the edited row, so the status (new volume or not) follows it
  useEffect(() => {
    if (!volumeEdited || singleId === null || singlePage === null || singleCapture === null) return
    const v = volumeFromFields(volumeText)
    if (v === 'invalid') return
    let stale = false
    setSingle((s) => (s !== null && s.batchId === singleId ? { ...s, status: null } : s))
    const row = { ...rowWithVolume(singlePage, v), capture: singleCapture }
    trpcClient.shelf.preview
      .mutate({ rows: [row] })
      .then(({ statuses }) => {
        if (!stale) setSingle((s) => (s !== null && s.batchId === singleId ? { ...s, status: statuses[0] ?? { kind: 'new' } } : s))
      })
      .catch((e: unknown) => {
        if (stale) return
        setSingle((s) => (s !== null && s.batchId === singleId ? { ...s, status: { kind: 'new' } } : s))
        toast.error(message(e))
      })
    return () => {
      stale = true
    }
  }, [volumeEdited, volumeText, singleId, singlePage, singleCapture])
  // the batch import has no wishlist choice
  const batchOwnership = ownership === 'wishlist' ? 'owned' : ownership
  const wishes = useQuery({ ...trpc.wishlist.list.queryOptions({ userId }), enabled: single !== null })
  const wishedWorkId = single?.status?.kind === 'have' || single?.status?.kind === 'copy_of' || single?.status?.kind === 'new_volume' ? single.status.workId : null
  const alreadyWished = wishedWorkId !== null && (wishes.data?.some((w) => w.workId === wishedWorkId) ?? false)
  // an existing wish seeds the form once when the list arrives (per book and match), so "Update my wish" never blanks its formats and note
  const seededFor = useRef<string | null>(null)
  useEffect(() => {
    if (single === null || wishes.data === undefined) return
    const key = `${single.batchId}:${wishedWorkId ?? ''}`
    if (seededFor.current === key) return
    seededFor.current = key
    const seed = existingWishDraft(wishes.data, wishedWorkId)
    // leave a form the person has already edited alone
    if (seed !== null) setWishDraft((cur) => (JSON.stringify(cur) === JSON.stringify(emptyDraft(single.page)) ? seed : cur))
  }, [single, wishes.data, wishedWorkId])
  const [reading, setReading] = useState(false)
  const [copyFailed, setCopyFailed] = useState<'prompt' | 'setup' | null>(null)
  /** the latest rows, for handlers that run after an await (a capture, a preview) */
  const rowsRef = useRef<ReviewRow[]>([])
  const previewSeq = useRef(0)

  const setAllRows = (next: ReviewRow[]) => {
    rowsRef.current = next
    setRows(next)
  }
  const from = ownership === 'borrowed' && borrowedFrom.trim() !== '' ? borrowedFrom.trim() : null

  /** Statuses for every row (a repeat depends on the others); an older answer never overwrites a newer one. */
  async function preview(next: ReviewRow[]): Promise<void> {
    const id = ++previewSeq.current
    try {
      const { statuses } = await trpcClient.shelf.preview.mutate({ rows: next.map((r) => ({ ...r.row, capture: r.capture })) })
      if (id === previewSeq.current) setAllRows(applyStatuses(rowsRef.current, statuses))
    } catch (e) {
      if (id === previewSeq.current) setAllRows(settleStatuses(rowsRef.current))
      toast.error(message(e))
    }
  }

  async function read(text = answer) {
    const parsed = parseShelfAnswer(text)
    if (!parsed.ok) {
      setParseError(parsed.error)
      return
    }
    setParseError(null)
    const format = shelfAnswerFormat(text)
    setNotes({ unreadable: parsed.value.unreadable, truncated: parsed.value.truncated, outdated: format !== null && format < SHELF_FORMAT })
    setLinked({})
    setBatchId(newImportId())
    const next = rowsFromAnswer(parsed.value.rows, newImportId)
    setAllRows(next)
    if (next.length === 0) return
    setReading(true)
    await preview(next)
    setReading(false)
  }

  const importList = useMutation({
    mutationFn: () => {
      if (batchId === null) throw new Error('Read the list first')
      return trpcClient.shelf.import.mutate({ batchId, label: batchLabel(todayLocal()), ownership: batchOwnership, borrowedFrom: from, rows: importRows(rows) })
    },
    onSuccess: ({ sourceId, proposalIds }) => {
      toast.success(`Added ${proposalIds.length} ${proposalIds.length === 1 ? 'book' : 'books'} to your Inbox`)
      void navigate({ to: '/inbox', search: { batch: sourceId } })
    },
  })

  /** Links a row to a page; throws (for the caller to show) when the page is not a book. */
  async function linkRow(key: string, capture: PageCapture) {
    const page = await trpcClient.shelf.extract.mutate({ capture })
    setLinked((l) => ({ ...l, [key]: page }))
    const next = setCapture(rowsRef.current, key, capture)
    setAllRows(next)
    await preview(next)
  }

  // a book found by its barcode: once it's added, the page stays and the scanner opens for the next one (#157)
  const singleScanned = useRef(false)
  const [scanRequest, setScanRequest] = useState(0)

  /** Opens the single-book review; throws (for the caller to show) when the page is not a book. */
  async function openSingle(capture: PageCapture, scanned = false) {
    const page = await trpcClient.shelf.extract.mutate({ capture })
    const book: SingleBook = { page, capture, status: null, batchId: newImportId() }
    singleScanned.current = scanned
    if (scanned) scrollToSingle.current = true
    setSingle(book)
    setWishDraft(emptyDraft(page))
    setVolumeText(fieldsFromVolume(page.volume))
    setVolumeEdited(false)
    try {
      const { statuses } = await trpcClient.shelf.preview.mutate({ rows: [{ ...rowFromExtracted(page), capture }] })
      setSingle((s) => (s !== null && s.batchId === book.batchId ? { ...s, status: statuses[0] ?? { kind: 'new' } } : s))
    } catch (e) {
      // no duplicate check: offer it as a new book rather than leaving the review on "Checking…"
      setSingle((s) => (s !== null && s.batchId === book.batchId ? { ...s, status: { kind: 'new' } } : s))
      toast.error(message(e))
    }
  }

  useCapture((capture) => {
    // a page sent for an Inbox book (also by the #capture= fallback, which always lands here) is attached to it
    const target = takeTarget()
    if (target?.kind === 'proposal') {
      void trpcClient.shelf.attachPage
        .mutate({ proposalId: target.id, capture })
        .then((r) => {
          toast.success(<span dir="auto">Linked: {r.title}</span>)
          void queryClient.invalidateQueries({ queryKey: trpc.inbox.pathKey() })
          void navigate({ to: '/inbox', search: { item: target.id } })
        })
        .catch((e: unknown) => toast.error(message(e)))
    } else if (target?.kind === 'work') {
      // a page sent for a book's "Fetch details" goes back to that book, which reads it from the address
      void navigate({ to: '/books/$workId', params: { workId: target.id }, hash: `capture=${encodeURIComponent(JSON.stringify(capture))}` })
    } else if (target?.kind === 'row' && rowsRef.current.some((r) => r.key === target.key)) linkRow(target.key, capture).catch((e: unknown) => toast.error(message(e)))
    // a row target whose row is gone (page reloaded) falls through to the single-book review
    else openSingle(capture).catch((e: unknown) => toast.error(message(e)))
  })

  const addOne = useMutation({
    mutationFn: (book: SingleBook) => {
      const s = book.status
      if (ownership === 'wishlist') {
        const v = volumeEdited ? volumeFromFields(volumeText) : undefined
        if (v === 'invalid') throw new Error('Check the volume')
        return trpcClient.wishlist.addFromPage.mutate({ capture: book.capture, target: wishTarget(s), ...fieldsFromDraft(wishDraft), ...(v === undefined ? {} : { volume: v }) })
      }
      const v = volumeEdited ? volumeFromFields(volumeText) : undefined
      if (v === 'invalid') throw new Error('Check the volume')
      return trpcClient.shelf.addOne.mutate({
        batchId: book.batchId,
        label: batchLabel(todayLocal()),
        ownership,
        borrowedFrom: from,
        row: v === undefined ? null : rowWithVolume(book.page, v),
        capture: book.capture,
        target: addTarget(s),
        today: todayLocal(),
      })
    },
    onSuccess: ({ workId }) => {
      if (singleScanned.current) {
        const wish = ownership === 'wishlist'
        if (wish) invalidateWishes(queryClient)
        toast.success(wish ? 'Added to your wishlist' : 'Added', {
          action: { label: 'Open', onClick: () => void navigate(wish ? { to: '/wishlist' } : { to: '/books/$workId', params: { workId } }) },
        })
        closeSingle()
        setScanRequest((n) => n + 1)
        return
      }
      if (ownership === 'wishlist') {
        toast.success('Added to your wishlist')
        invalidateWishes(queryClient)
        void navigate({ to: '/wishlist' })
        return
      }
      toast.success('Added')
      void navigate({ to: '/books/$workId', params: { workId } })
    },
  })

  /** Closing the single review forgets its Wishlist choice, which the batch import cannot hold. */
  function closeSingle() {
    setSingle(null)
    setOwnership((o) => (o === 'wishlist' ? 'owned' : o))
  }

  async function copyPrompt(which: 'prompt' | 'setup') {
    const [text, area, details] = which === 'prompt' ? [SHELF_PROMPT, promptArea, promptDetails] : [SHELF_SETUP_PROMPT, setupArea, setupDetails]
    // plain http has no Clipboard API: the fallback selects the textarea, which must be rendered, so open it now (synchronously, in the click)
    if (!window.isSecureContext && details.current) details.current.open = true
    if (await copyText(text, area.current)) {
      toast.success(which === 'prompt' ? 'Prompt copied' : 'Setup prompt copied')
    } else {
      setCopyFailed(which)
      if (details.current) details.current.open = true
    }
  }

  // a share from another app (the manifest's share_target): read once, then dropped from the address so a reload doesn't repeat it
  const singleBox = useRef<HTMLDivElement>(null)
  const scrollToSingle = useRef(false)
  const shareTaken = useRef(false)
  useEffect(() => {
    if (shareTaken.current) return
    shareTaken.current = true
    const shared = sharedFromSearch(window.location.search)
    if (shared === null) return
    void navigate({ to: '/books/shelf', search: {}, replace: true })
    if (shared.kind === 'answer') {
      setAnswer(shared.text)
      document.getElementById('shelf-answer')?.scrollIntoView({ block: 'start' })
      void read(shared.text)
      return
    }
    // one request for the one page shared, as when its link is pasted
    scrollToSingle.current = true
    trpcClient.shelf.fetchPage
      .mutate({ proposalId: null, text: shared.text })
      .then(({ capture }) => openSingle(capture))
      .catch((e: unknown) => toast.error(message(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, [])
  useEffect(() => {
    if (singleId === null || !scrollToSingle.current) return
    scrollToSingle.current = false
    singleBox.current?.scrollIntoView({ block: 'start' })
  }, [singleId])

  const unreadable = notes?.unreadable ?? []
  return (
    <PageBody width="narrow">
      <PageHeader title="Add from a shelf photo" description="Photograph a shelf or a stack, let your own AI read it, and review the list before anything is added." />
      {/* pb: with the on-screen keyboard up, the page can still scroll the last row above the sticky bar */}
      <PageSections className="pb-[var(--keyboard-inset,0px)] lg:pb-0">
        <Card>
          <CardHeader>
            <CardTitle>1 · Ask your AI</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <p>Open Claude or Gemini on your phone and attach the photo.</p>
            <p>Paste the prompt and send.</p>
            <p>Copy the whole answer and paste it below.</p>
            <div>
              <Button type="button" onClick={() => void copyPrompt('prompt')}>
                Copy prompt
              </Button>
            </div>
            <details ref={promptDetails}>
              <summary className="cursor-pointer">Show the prompt</summary>
              {copyFailed === 'prompt' ? <p className="mt-2 text-xs text-muted-foreground">Select the prompt and copy it</p> : null}
              <Textarea ref={promptArea} readOnly dir="ltr" aria-label="The prompt" value={SHELF_PROMPT} className="mt-2 text-xs" onFocus={(e) => e.currentTarget.select()} />
            </details>
            <div className="grid gap-2 border-t pt-3">
              <p className="font-medium">Set it up once</p>
              <p className="text-muted-foreground">Send this to your AI once and it saves the instructions as a skill. After that, attach the photo and write “use My Library shelf photo”.</p>
              <div>
                <Button type="button" variant="outline" onClick={() => void copyPrompt('setup')}>
                  Copy setup prompt
                </Button>
              </div>
              <details ref={setupDetails}>
                <summary className="cursor-pointer">Show the setup prompt</summary>
                {copyFailed === 'setup' ? <p className="mt-2 text-xs text-muted-foreground">Select the setup prompt and copy it</p> : null}
                <Textarea ref={setupArea} readOnly dir="ltr" aria-label="The setup prompt" value={SHELF_SETUP_PROMPT} className="mt-2 text-xs" onFocus={(e) => e.currentTarget.select()} />
              </details>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2 · Paste the answer</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="shelf-answer">The AI's answer</Label>
              <Textarea id="shelf-answer" dir="auto" rows={5} value={answer} onChange={(e) => setAnswer(e.target.value)} />
            </div>
            <div>
              <Button type="button" disabled={answer.trim() === '' || reading} onClick={() => void read()}>
                Read the list
              </Button>
            </div>
            {parseError !== null ? (
              <p role="alert" className="text-sm text-destructive" dir="auto">
                {parseError}
              </p>
            ) : null}
            {notes?.outdated ? (
              <p role="status" className="text-sm font-medium">
                Your saved AI setup is out of date — copy the setup prompt again and send it to your AI.
              </p>
            ) : null}
            {unreadable.map((u) => (
              <p key={u.position} className="text-sm text-muted-foreground">
                Row {u.position}: {u.reason}
              </p>
            ))}
            {notes?.truncated ? <p className="text-sm text-muted-foreground">Only the first 100 books were read</p> : null}
          </CardContent>
        </Card>

        {rows.length > 0 ? (
          <ReviewList
            rows={rows}
            linked={linked}
            onToggle={(key) => setAllRows(toggle(rowsRef.current, key))}
            onEdit={(key, patch) => {
              const next = editRow(rowsRef.current, key, patch)
              setAllRows(next)
              void preview(next)
            }}
            onPickMaybe={(key) => {
              const status = rowsRef.current.find((r) => r.key === key)?.status
              if (status?.kind === 'maybe') setAllRows(setPreset(rowsRef.current, key, { workId: status.workId, title: status.title }))
            }}
            onLink={linkRow}
            ownership={batchOwnership}
            onOwnership={setOwnership}
            borrowedFrom={borrowedFrom}
            onBorrowedFrom={setBorrowedFrom}
            importing={importList.isPending}
            onImport={() => importList.mutate()}
          />
        ) : null}

        <Card role="region" aria-labelledby="shelf-one-book">
          <CardHeader>
            <CardTitle id="shelf-one-book">Add one book</CardTitle>
            <CardDescription>Look it up or scan its barcode, pick it, and check it before it's added.</CardDescription>
          </CardHeader>
          <CardContent>
            <BookLinker idPrefix="single" seed={NO_SEED} target={{ kind: 'search' }} onCapture={openSingle} scanRequest={scanRequest} />
          </CardContent>
        </Card>

        <div ref={singleBox} className="scroll-mt-4" hidden={single === null}>
          {single !== null ? (
            <SingleBookReview
              book={single}
              ownership={ownership}
              onOwnership={setOwnership}
              borrowedFrom={borrowedFrom}
              onBorrowedFrom={setBorrowedFrom}
              wishDraft={wishDraft}
              onWishDraft={setWishDraft}
              alreadyWished={alreadyWished}
              wishesLoaded={wishes.data !== undefined}
              adding={addOne.isPending}
              onAdd={() => addOne.mutate(single)}
              onCancel={closeSingle}
              onPickMaybe={() => setSingle((s) => (s === null ? s : { ...s, status: pickMaybe(s.status) }))}
              volume={volumeText}
              onVolume={(v) => {
                setVolumeText(v)
                setVolumeEdited(true)
              }}
            />
          ) : null}
        </div>

        <BookmarkletSetup />
      </PageSections>
    </PageBody>
  )
}
