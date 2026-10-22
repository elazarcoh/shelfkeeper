import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { tokenize, type WorkCard } from '@mylib/domain'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { returnFocusProps } from '@/components/dialog-focus'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useQuickActions } from '@/features/library/quick-actions/use-quick-actions'
import { useDebounced } from '@/lib/use-debounced'
import { trpc } from '@/lib/trpc'
import { bookSearchPending } from './book-search-state'
import { bookItems, matchesQuery } from './book-items'
import { usePalette } from './palette-context'
import { paletteGroups, type PaletteItem, type PaletteTarget } from './palette-model'

const LISTS = { staleTime: 5 * 60_000 }

/** Stands in while no book is chosen: its queries are disabled (`open` false) and its model is never shown. */
const NO_BOOK: WorkCard = { id: '', title: '', subtitle: null, kind: 'book', authors: [], series: null, formats: [], availability: 'owned', status: 'none', rating: null, inQueue: false, wishedBy: [], coverAssetId: null }

/** The one palette, mounted in the app shell. */
export function CommandPalette({ isAdmin }: { isAdmin: boolean }) {
  const { open, setOpen, openCount, returnFocus, dropReturnFocus } = usePalette()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // fetch the lists from the first opening on (and keep them), never before
  const used = openCount > 0

  const [query, setQuery] = useState('')
  const [value, setValue] = useState('')
  // the chosen book (the Book screen); reset on the next opening, never on close, so a toast's Undo still reaches this hook
  const [book, setBook] = useState<WorkCard | null>(null)
  const [seen, setSeen] = useState(openCount)
  if (seen !== openCount) {
    // a new opening starts at Root with an empty input
    setSeen(openCount)
    setQuery('')
    setValue('')
    setBook(null)
  }

  // the hook lives here, outside DialogContent, so it outlives the closed dialog
  const actions = useQuickActions(book ?? NO_BOOK, isAdmin, book !== null, () => {})

  const settled = useDebounced(query, 200)
  const books = useQuery({ ...trpc.library.search.queryOptions({ q: settled, limit: 8 }), enabled: open && book === null && settled === query && tokenize(settled).length > 0 })
  const facets = useQuery({ ...trpc.catalog.facets.queryOptions(), ...LISTS, enabled: used })
  const sets = useQuery({ ...trpc.sets.mine.queryOptions(), ...LISTS, enabled: used })
  const suggestions = useQuery({ ...trpc.catalog.suggestions.queryOptions(), ...LISTS, enabled: used })
  const users = useQuery({ ...trpc.admin.users.list.queryOptions(), ...LISTS, enabled: used && isAdmin })

  const groups = paletteGroups(
    query,
    {
      // only results for the query on screen: a slower, older response never shows under a newer query
      books: settled === query ? books.data?.items : undefined,
      authors: facets.data?.authors,
      series: facets.data?.series,
      tags: facets.data?.tags,
      sets: sets.data,
      users: isAdmin ? users.data : undefined,
      borrowers: suggestions.data?.borrowers,
    },
    { isAdmin },
  )

  // no "No matches" until the Books group for this query has had its say
  const booksPending = book === null && bookSearchPending(query, settled, books.isFetching)

  function back() {
    setBook(null)
    setQuery('')
  }

  function go(target: PaletteTarget) {
    switch (target.kind) {
      case 'page':
        void navigate({ to: target.to })
        break
      case 'library':
        void navigate({ to: '/library', search: target.search })
        break
      case 'user':
        void navigate({ to: '/admin/users/$userId', params: { userId: target.userId } })
        break
      case 'checkin':
        void navigate({ to: '/', search: { checkin: true }, replace: pathname === '/' })
        break
      case 'book':
        setBook(target.card)
        setQuery('')
        return
    }
    dropReturnFocus()
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        data-palette=""
        bare
        {...returnFocusProps(returnFocus)}
        className="sm:max-w-xl"
        onEscapeKeyDown={(e) => {
          if (book !== null) {
            e.preventDefault()
            back()
          }
        }}
      >
        <DialogTitle className="sr-only">Search and commands</DialogTitle>
        <DialogDescription className="sr-only">Type to find books, people and pages, or pick a command.</DialogDescription>
        <Command
          shouldFilter={false}
          loop
          value={value}
          onValueChange={setValue}
          className="min-h-0 flex-1"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && book === null && value.startsWith('book:')) {
              e.preventDefault()
              void navigate({ to: '/books/$workId', params: { workId: value.slice('book:'.length) } })
              dropReturnFocus()
              setOpen(false)
            } else if (e.key === 'Backspace' && book !== null && query === '') {
              e.preventDefault()
              back()
            }
          }}
        >
          {book !== null ? (
            <div className="flex min-h-12 items-center gap-1 border-b ps-1 pe-10 pointer-coarse:min-h-14 pointer-coarse:pe-12">
              <Button type="button" variant="ghost" size="icon" aria-label="Back" className="size-9 shrink-0 pointer-coarse:size-11" onClick={back}>
                <ArrowLeft className="size-4 rtl:rotate-180" />
              </Button>
              <div className="min-w-0 flex-1 py-2">
                <p dir="auto" className="truncate font-medium">{book.title}</p>
                {book.authors.length > 0 ? <p dir="auto" className="truncate text-sm text-muted-foreground">{book.authors.join(', ')}</p> : null}
              </div>
            </div>
          ) : null}
          <CommandInput
            value={query}
            onValueChange={setQuery}
            dir="auto"
            className="pe-8 pointer-coarse:pe-10"
            aria-label="Search books, people, pages and commands"
            placeholder={book !== null ? 'Actions for this book…' : 'Search books, people, pages…'}
          />
          <CommandList className="max-h-[min(60dvh,28rem)] pb-[env(safe-area-inset-bottom)]">
            {tokenize(query).length > 0 && !booksPending ? <CommandEmpty>No matches</CommandEmpty> : null}
            {book !== null ? (
              <CommandGroup heading="Actions">
                {bookItems(actions.model)
                  .filter((i) => matchesQuery(query, i.label))
                  .map((i) => (
                    <CommandItem
                      key={i.id}
                      value={`do:${i.id}`}
                      disabled={'action' in i && (i.disabled || actions.pending(i.id))}
                      onSelect={() => {
                        if (!('action' in i)) {
                          void navigate({ to: '/books/$workId', params: { workId: book.id } })
                          dropReturnFocus()
                        } else actions.run(i.action)
                        setOpen(false)
                      }}
                    >
                      <span dir="auto">{i.label}</span>
                    </CommandItem>
                  ))}
              </CommandGroup>
            ) : (
              groups.map((g) => (
                <CommandGroup key={g.id} heading={g.heading}>
                  {g.items.map((item) => (
                    <PaletteRow key={item.id} item={item} onSelect={() => go(item.target)} />
                  ))}
                </CommandGroup>
              ))
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function PaletteRow({ item, onSelect }: { item: PaletteItem; onSelect: () => void }) {
  return (
    <CommandItem value={item.id} onSelect={onSelect} className="flex items-baseline gap-2">
      <span dir="auto" className="min-w-0 truncate">{item.label}</span>
      {item.hint !== undefined ? <span dir="auto" className="ms-auto min-w-0 shrink truncate text-xs text-muted-foreground">{item.hint}</span> : null}
    </CommandItem>
  )
}
