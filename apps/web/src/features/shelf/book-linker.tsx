import { useMutation } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ScanBarcode, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { defaultSourceFor, prefillQuery, providerById, sourceLabel, type ExtractedPage, type MetadataSource, type PageCapture } from '@mylib/domain'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SearchInput } from '@/components/ui/search-input'
import { trpcClient } from '@/lib/trpc'
import { BarcodeScanner } from './barcode-scanner'
import { rememberTarget, type CaptureTarget } from './capture-target'
import { HardcoverResults, Versions } from './hardcover-results'
import { detailsLine, ResultRow } from './result-row'

export interface LinkSeed {
  title: string
  subtitle: string | null
  series: string | null
  authors: string[]
  spineText: string | null
  language: string | null
  /** a copy's own ISBN, searched first */
  isbn?: string | null
}

/** What picking on the Hardcover tab hands over: the page itself (ISBN or pasted link), or the book (and version) to read. */
export type HardcoverPick = { page: ExtractedPage; editionId: number | null } | { hardcoverId: number; editionId: number | null }

export interface HardcoverLinkOptions {
  /** the prefill for the Hardcover tab (a book page passes suggestQuery's text) */
  query?: string
  /** the book's current match (book page only) */
  current?: { hardcoverId: number; slug: string | null } | null
  onUnlink?: () => Promise<unknown>
  onPick: (pick: HardcoverPick) => Promise<unknown>
}

const message = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong')

const HARDCOVER_LINK = /https?:\/\/\S*hardcover\.app\S*/i

type ScanFound = Awaited<ReturnType<typeof trpcClient.shelf.byIsbn.mutate>>

/** What a scan found besides the page it hands on: the book already here, or where it was looked for in vain. */
function ScanResult({ found }: { found: ScanFound }) {
  const looked = found.tried.map((s) => sourceLabel(s)).join(' or ')
  const silent = found.failed.map((s) => sourceLabel(s)).join(' and ')
  return (
    <div role="status" className="grid gap-1 text-sm">
      {found.have !== null ? (
        <p>
          You have this:{' '}
          <Link to="/books/$workId" params={{ workId: found.have.workId }} className="underline" dir="auto">
            {found.have.title}
          </Link>
        </p>
      ) : null}
      {found.capture === null ? (
        <p className="text-muted-foreground">
          <span dir="ltr">{found.isbn}</span>
          {looked === '' ? " couldn't be looked up" : ` isn't on ${looked}`}
          {silent === '' ? '' : ` (${silent} didn't answer)`} — search Simania for it, or type the book in.
        </p>
      ) : null}
    </div>
  )
}

/**
 * Finds a book's page and hands it on: Hardcover and Open Library are searched right here (tap a row to pick it),
 * Simania opens in a new tab (its page comes back by the bookmarklet, or by pasting its link). Pasting a link works for all.
 */
export function BookLinker({
  seed,
  target,
  onCapture,
  idPrefix,
  hardcover,
  initialSource,
  scanRequest = 0,
}: {
  seed: LinkSeed
  target: CaptureTarget
  /** `scanned`: the page came from a barcode (#157) */
  onCapture: (capture: PageCapture, scanned?: boolean) => Promise<unknown>
  idPrefix: string
  /** absent: no Hardcover tab */
  hardcover?: HardcoverLinkOptions
  initialSource?: MetadataSource
  /** each new value opens the scanner (the next book in a row of scans) */
  scanRequest?: number
}) {
  const [source, setSource] = useState<MetadataSource>(() => initialSource ?? defaultSourceFor(seed, hardcover !== undefined))
  const tabs: MetadataSource[] = hardcover === undefined ? ['openlibrary', 'simania'] : ['hardcover', 'openlibrary', 'simania']
  const label = sourceLabel(source)
  const prefill = (s: MetadataSource): string => (s === 'hardcover' ? (hardcover?.query ?? prefillQuery(seed)) : prefillQuery(seed))
  // what was typed on each tab; until then the prefill (which may arrive late) shows
  const [typed, setTyped] = useState<Partial<Record<MetadataSource, string>>>({})
  const query = typed[source] ?? prefill(source)
  const [link, setLink] = useState('')
  const [searchAgain, setSearchAgain] = useState(false)
  // errors show inline, never as a toast: this sits inside a dialog
  const [error, setError] = useState<string | null>(null)
  const linkId = `${idPrefix}-link`

  const search = useMutation({
    mutationFn: (q: string) => trpcClient.shelf.search.mutate({ query: q }),
    onMutate: () => setError(null),
    onError: (e) => setError(message(e)),
  })
  const pick = useMutation({
    mutationFn: (capture: PageCapture) => onCapture(capture),
    onMutate: () => setError(null),
    onError: (e) => setError(message(e)),
  })
  const pickHardcover = useMutation({
    mutationFn: (choice: HardcoverPick) => (hardcover === undefined ? Promise.resolve() : hardcover.onPick(choice)),
    onMutate: () => setError(null),
    onError: (e) => setError(message(e)),
  })
  const lookup = useMutation({
    mutationFn: async (q: string) => {
      const found = await trpcClient.hardcover.lookup.mutate({ query: q })
      // an ISBN that Hardcover knows needs no choosing
      if (found.kind === 'page') {
        await hardcover?.onPick({ page: found.page, editionId: found.editionId })
        return null
      }
      return found.results
    },
    onMutate: () => setError(null),
    onError: (e) => setError(message(e)),
  })
  const unlink = useMutation({
    mutationFn: async () => {
      await hardcover?.onUnlink?.()
    },
    onMutate: () => setError(null),
    onError: (e) => setError(message(e)),
  })
  const paste = useMutation({
    mutationFn: async (text: string) => {
      const hardcoverLink = hardcover === undefined ? null : HARDCOVER_LINK.exec(text)?.[0]
      if (hardcoverLink !== undefined && hardcoverLink !== null) {
        const { page, editionId } = await trpcClient.hardcover.pageByUrl.mutate({ url: hardcoverLink })
        await hardcover?.onPick({ page, editionId })
        return
      }
      const { capture } = await trpcClient.shelf.fetchPage.mutate({ proposalId: null, text })
      await onCapture(capture)
    },
    onSuccess: () => setLink(''),
    onMutate: () => setError(null),
    onError: (e) => setError(message(e)),
  })

  // #157: a scanned ISBN is looked up on Open Library and the National Library; Simania is left for the person to open
  const [scanning, setScanning] = useState(false)
  useEffect(() => {
    if (scanRequest > 0) setScanning(true)
  }, [scanRequest])
  const byIsbn = useMutation({
    mutationFn: async (isbn: string) => {
      const found = await trpcClient.shelf.byIsbn.mutate({ isbn })
      if (found.capture !== null) await onCapture(found.capture, true)
      else {
        // not found: the ISBN waits on the Simania tab, one tap from its search
        setSource('simania')
        setTyped((t) => ({ ...t, simania: found.isbn }))
      }
      return found
    },
    onMutate: () => {
      setError(null)
      search.reset()
      lookup.reset()
    },
    onError: (e) => setError(message(e)),
  })
  const scanned = byIsbn.data ?? null

  const choose = (next: MetadataSource) => {
    setSource(next)
    setError(null)
    search.reset()
    lookup.reset()
  }
  const find = () => {
    const q = query.trim()
    if (q === '' || searching || busy) return
    if (source === 'hardcover') {
      lookup.mutate(q)
      return
    }
    if (source === 'openlibrary') {
      search.mutate(q)
      return
    }
    rememberTarget(target)
    // opened without `noopener`: the bookmarklet posts the page back through the opener
    window.open(providerById('simania').searchUrl(q), '_blank')
  }
  const busy = pick.isPending || pickHardcover.isPending || paste.isPending || lookup.isPending || unlink.isPending || byIsbn.isPending
  const current = source === 'hardcover' && !searchAgain ? hardcover?.current : null
  const searching = source === 'hardcover' ? lookup.isPending : source === 'openlibrary' ? search.isPending : false
  const hardcoverHits = lookup.data ?? null

  return (
    <div className="grid min-w-0 grid-cols-1 gap-2">
      <div role="tablist" aria-label="Look it up on" className="flex gap-1 rounded-md bg-muted p-1">
        {tabs.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === source}
            onClick={() => choose(id)}
            className={`min-w-0 flex-1 truncate rounded-sm px-2 py-1.5 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11 ${id === source ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
          >
            {sourceLabel(id)}
          </button>
        ))}
      </div>

      {current != null ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Current match</span>
            <a href={`https://hardcover.app/id/book/${current.hardcoverId}`} target="_blank" rel="noreferrer" className="shrink-0 px-1 py-2 text-xs underline">
              Open ↗
            </a>
          </div>
          <ul aria-label="Current match" className="grid gap-2">
            <ResultRow
              coverUrl={null}
              title={current.slug ?? `Hardcover book ${current.hardcoverId}`}
              details=""
              label={`Use ${current.slug ?? `Hardcover book ${current.hardcoverId}`}`}
              disabled={busy}
              onPick={() => pickHardcover.mutate({ hardcoverId: current.hardcoverId, editionId: null })}
              below={<Versions hardcoverId={current.hardcoverId} busy={busy} onPick={(editionId) => pickHardcover.mutate({ hardcoverId: current.hardcoverId, editionId })} onError={setError} />}
            />
          </ul>
          <p className="text-xs text-muted-foreground">
            Wrong match?{' '}
            <button type="button" className="py-1 underline" onClick={() => setSearchAgain(true)}>
              Search again
            </button>
            {hardcover?.onUnlink === undefined ? null : (
              <>
                {' · '}
                <button type="button" className="py-1 underline" disabled={busy} onClick={() => unlink.mutate()}>
                  Unlink
                </button>
              </>
            )}
          </p>
        </>
      ) : (
        <>
          <SearchInput
            aria-label={`Search ${label} for`}
            dir="auto"
            className="pr-20 pointer-coarse:pr-24"
            value={query}
            onValueChange={(v) => setTyped((t) => ({ ...t, [source]: v }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                find()
              }
            }}
            trailing={
              <button
                type="button"
                aria-label={source === 'simania' ? 'Open Simania' : `Search ${label}`}
                disabled={query.trim() === '' || searching}
                onClick={find}
                className="pointer-events-auto flex size-9 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 pointer-coarse:size-11"
              >
                <Search className="size-4" />
              </button>
            }
          />

          <div>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setScanning(true)}>
              <ScanBarcode /> {byIsbn.isPending ? 'Looking it up…' : 'Scan barcode'}
            </Button>
          </div>
          {scanned !== null && !byIsbn.isPending ? <ScanResult found={scanned} /> : null}

          {source === 'openlibrary' && search.data !== undefined ? (
            search.data.results.length === 0 ? (
              <p className="text-sm text-muted-foreground">No books found — try another search</p>
            ) : (
              <ul aria-label="Open Library results" className="grid gap-2">
                {search.data.results.map(({ page, capture }) => (
                  <ResultRow
                    key={page.providerId}
                    coverUrl={page.coverUrl}
                    title={page.title}
                    details={detailsLine([page.authors.join(', '), page.year, page.series === null ? null : `${page.series.name}${page.series.position === null ? '' : ` #${page.series.position}`}`])}
                    label={`Use ${page.title}`}
                    disabled={busy}
                    onPick={() => pick.mutate(capture)}
                  />
                ))}
              </ul>
            )
          ) : null}

          {source === 'hardcover' && hardcoverHits !== null ? (
            <HardcoverResults results={hardcoverHits} busy={busy} onPick={(hardcoverId, editionId) => pickHardcover.mutate({ hardcoverId, editionId })} onError={setError} />
          ) : null}
        </>
      )}

      {error !== null ? (
        <p role="alert" dir="auto" className="text-sm text-destructive wrap-anywhere">
          {error}
        </p>
      ) : null}

      <BarcodeScanner open={scanning} onOpenChange={setScanning} onIsbn={(isbn) => byIsbn.mutate(isbn)} />

      <details className="group pt-1">
        <summary className="cursor-pointer py-1.5 text-sm text-muted-foreground select-none">Have a link instead?</summary>
        <div className="grid gap-1.5 pt-1.5">
          <label htmlFor={linkId} className="text-sm">
            Or paste the book's link
          </label>
          <p className="text-xs text-muted-foreground">
            {source === 'simania'
              ? "On the book's page, tap Share → Copy link, then come back and paste it here."
              : hardcover === undefined
                ? 'A link to a book on Simania or Open Library.'
                : 'A link to a book on Hardcover, Open Library or Simania.'}
          </p>
          <div className="flex gap-2">
            <Input id={linkId} dir="ltr" inputMode="url" placeholder="https://…" value={link} onChange={(e) => setLink(e.target.value)} />
            <Button type="button" size="sm" disabled={link.trim() === '' || busy} onClick={() => paste.mutate(link)}>
              Link
            </Button>
          </div>
        </div>
      </details>
    </div>
  )
}
