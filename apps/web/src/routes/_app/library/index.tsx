import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useCanGoBack, useRouter } from '@tanstack/react-router'
import { BookUser, Gift, Layers, Sparkles, X } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { filterFromFacets } from '@mylib/domain'
import { LoadMore } from '@/components/load-more'
import { NameDialog } from '@/components/name-dialog'
import { NativeSelect } from '@/components/native-select'
import { EmptyState, PageBody, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { FilterFields, ViewToggle } from '@/features/library/filter-bar'
import { ActiveFilterChips, FiltersSheet, SeriesContext, SetContext } from '@/features/library/filters-sheet'
import { activeFilterChips, CLEAR_FACETS, clearFilters, hasFacets, hasRemovableFilters } from '@/features/library/library-filters'
import {
  collapseSeriesOn,
  entryKey,
  isPersonalLibraryEmpty,
  leaveSeries,
  PAGE_SIZE,
  parseLibrarySearch,
  readCollapsePreference,
  seriesSearch,
  seriesViewId,
  toLibraryQuery,
  writeCollapsePreference,
  type LibrarySearch,
} from '@/features/library/library-search'
import { ScopeSwitch } from '@/features/library/scope-switch'
import { SearchBox } from '@/features/library/search-box'
import { WorkList } from '@/features/library/work-list'
import { nextOffset, uniqueItems } from '@/lib/infinite'
import { trpc } from '@/lib/trpc'

function catalogSizeHint(books: number): string {
  if (books === 0) return 'The household catalog has no books yet.'
  return `The household catalog has ${books} ${books === 1 ? 'book' : 'books'}.`
}

export const Route = createFileRoute('/_app/library/')({
  validateSearch: (raw: Record<string, unknown>) => parseLibrarySearch(raw),
  component: LibraryPage,
})

function LibraryPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { user } = Route.useRouteContext()
  const queryClient = useQueryClient()
  const [saveScope, setSaveScope] = useState<'personal' | 'global'>('personal')

  const [collapsePreference, setCollapsePreference] = useState(readCollapsePreference)
  // more cards load as the list scrolls to its end (#49); a filter change starts again from the top
  const list = useInfiniteQuery(
    trpc.library.browse.infiniteQueryOptions(toLibraryQuery(search, collapsePreference), {
      initialCursor: 0,
      getNextPageParam: (_last, pages) => nextOffset(pages, PAGE_SIZE),
      placeholderData: keepPreviousData,
    }),
  )
  const items = useMemo(() => uniqueItems(list.data?.pages ?? [], entryKey), [list.data])
  const facets = useQuery(trpc.catalog.facets.queryOptions())
  const sets = useQuery(trpc.sets.mine.queryOptions())
  const createSet = useMutation(trpc.sets.create.mutationOptions())

  const update = useCallback(
    (patch: Partial<LibrarySearch>) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
    },
    [navigate],
  )
  const onSearch = useCallback((q: string) => update({ q: q === '' ? undefined : q }), [update])

  // books are what the header counts (a series card holds several)
  const books = list.data?.pages[0]?.books ?? 0
  const filter = filterFromFacets(search)
  const chips = activeFilterChips(search, facets.data)
  const view = search.view ?? 'grid'
  const setView = (next: 'grid' | 'list') => update({ view: next === 'list' ? 'list' : undefined })
  const currentSet = sets.data?.find((s) => s.id === search.set)
  const seriesId = seriesViewId(search)
  const seriesName = seriesId === undefined ? undefined : (facets.data?.series.find((s) => s.id === seriesId)?.name ?? 'Series')
  // a merged-away (or emptied) series: its link has nothing left to show. Stale or capped facets can miss a live
  // series, so it also takes fresh facets and a loaded, empty list
  const seriesGone =
    seriesId !== undefined &&
    facets.data !== undefined &&
    !facets.isFetching &&
    !facets.data.series.some((s) => s.id === seriesId) &&
    list.isSuccess &&
    !list.isPlaceholderData &&
    books === 0
  const collapse = {
    on: collapseSeriesOn(search, collapsePreference),
    onChange: (on: boolean) => {
      setCollapsePreference(on)
      writeCollapsePreference(on)
      update({ collapse: on ? 'on' : 'off' })
    },
  }
  const seriesLink = useCallback((id: string) => seriesSearch(search, id), [search])
  // a new history entry (unlike a filter tweak), from the switch or the empty library's button: Back returns to the other scope
  const goScope = useCallback(
    (scope: 'library' | 'catalog') => void navigate({ search: (prev) => ({ ...prev, scope: scope === 'catalog' ? 'catalog' : undefined }) }),
    [navigate],
  )
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const onLeaveSeries = () => {
    const leave = leaveSeries(search, canGoBack)
    if (leave.kind === 'back') router.history.back()
    else void navigate({ search: (prev) => ({ ...prev, ...leave.search }) })
  }

  // My library with no books at all (not "no matches"): say how big the household catalog is instead
  const libraryEmpty = !list.isPlaceholderData && isPersonalLibraryEmpty(search, list.data?.pages[0]?.books)
  const catalog = useQuery({ ...trpc.library.browse.queryOptions({ scope: 'catalog', limit: 1 }), enabled: libraryEmpty })

  async function saveSmartSet(name: string) {
    if (!filter) return
    const created = await createSet.mutateAsync({ kind: 'smart', scope: saveScope, name, filter })
    await queryClient.invalidateQueries({ queryKey: trpc.sets.pathKey() })
    void navigate({ search: { set: created.id } })
  }

  return (
    <PageBody>
      <PageHeader
        title={search.set !== undefined ? (currentSet?.name ?? 'Set') : search.scope === 'catalog' ? 'Whole catalog' : 'My library'}
        description={list.data ? `${books} ${books === 1 ? 'book' : 'books'}` : undefined}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link to="/sets">
                <Layers className="size-4" /> Sets
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/wishlist">
                <Gift className="size-4" /> Wishlist
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/loans">
                <BookUser className="size-4" /> Lent out
              </Link>
            </Button>
            {hasFacets(search) && filter ? (
              <NameDialog
                title="Save as smart set"
                label="Set name"
                submitLabel="Save set"
                trigger={
                  <Button variant="outline" size="sm">
                    <Sparkles className="size-4" /> Save as smart set
                  </Button>
                }
                extra={
                  user.role === 'admin' ? (
                    <label className="grid gap-1 text-sm">
                      Visible to
                      <NativeSelect value={saveScope} onChange={(e) => setSaveScope(e.target.value === 'global' ? 'global' : 'personal')}>
                        <option value="personal">Only me</option>
                        <option value="global">Everyone (global set)</option>
                      </NativeSelect>
                    </label>
                  ) : null
                }
                onSubmit={saveSmartSet}
              />
            ) : null}
          </>
        }
      />
      {/* a set is browsed across the whole catalog, so in its view the set (and the way back) takes the switch's place;
          the row keeps the switch's height either way, so nothing below jumps when the sets load */}
      <div className="mb-3 flex min-h-[calc(2.25rem+6px)] min-w-0 items-center pointer-coarse:min-h-[calc(2.75rem+6px)]">
        {search.set !== undefined ? (
          // while the sets load, a placeholder name; a set that is gone (or not mine) still gets its way back
          <SetContext name={currentSet?.name ?? (sets.isPending ? '…' : 'Unknown set')} onLeave={() => update({ set: undefined })} />
        ) : (
          <ScopeSwitch value={search.scope ?? 'library'} onChange={goScope} />
        )}
      </div>
      {/* data-sticky-bar: index.css adds this row's height (--page-sticky-h) to scroll-padding-top below lg */}
      <div
        data-sticky-bar
        className="sticky top-(--top-offset) z-page-sticky -mx-4 mb-3 flex min-h-(--page-sticky-h) items-center gap-2 bg-background/95 px-4 py-2 backdrop-blur md:-mx-6 md:px-6 lg:static lg:mx-0 lg:bg-transparent lg:px-0 lg:py-0 lg:backdrop-blur-none"
      >
        <div className="min-w-0 flex-1">
          <SearchBox label="Search books" value={search.q ?? ''} onChange={onSearch} count={list.data && !list.isPlaceholderData ? `${books} ${books === 1 ? 'book' : 'books'}` : undefined} />
        </div>
        <div className="flex gap-2 lg:hidden">
          <FiltersSheet
            search={search}
            facets={facets.data}
            sets={sets.data}
            onChange={update}
            collapse={collapse}
            total={list.isPlaceholderData ? undefined : list.data?.pages[0]?.books}
          />
          <ViewToggle compact view={view} onChange={setView} />
        </div>
      </div>
      <FilterFields className="mb-4 hidden lg:grid" search={search} facets={facets.data} sets={sets.data} onChange={update} collapse={collapse} />
      {seriesId !== undefined && seriesName !== undefined && !seriesGone ? (
        <div className="mb-4 min-w-0">
          <SeriesContext id={seriesId} name={seriesName} onLeave={onLeaveSeries} />
        </div>
      ) : null}
      {chips.length > 0 ? (
        <div className="mb-4 grid gap-2 lg:hidden">
          <ActiveFilterChips chips={chips} onRemove={update} />
        </div>
      ) : null}
      <div className="mb-4 hidden items-center justify-end gap-2 lg:flex">
        {hasRemovableFilters(search) ? (
          <Button variant="ghost" size="sm" onClick={() => update(clearFilters(search))}>
            <X className="size-4" /> Clear filters
          </Button>
        ) : null}
        <ViewToggle view={view} onChange={setView} />
      </div>

      {seriesGone ? (
        <EmptyState
          title="This series no longer exists"
          hint="It may have been merged into another series."
          action={
            <Button variant="outline" onClick={onLeaveSeries}>
              Back to the library
            </Button>
          }
        />
      ) : list.isPending ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(6.25rem,1fr))] gap-x-3 gap-y-5 md:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] md:gap-x-4">
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton key={i} className="aspect-[2/3]" />
          ))}
        </div>
      ) : items.length > 0 ? (
        <>
          <WorkList items={items} view={view} seriesLink={seriesLink} isAdmin={user.role === 'admin'} meId={user.id} />
          {list.hasNextPage && !list.isPlaceholderData ? (
            <LoadMore loading={list.isFetchingNextPage} failed={list.isFetchNextPageError} onMore={() => void list.fetchNextPage()} />
          ) : null}
        </>
      ) : libraryEmpty ? (
        <EmptyState
          title="Your library is empty"
          hint={catalog.data === undefined ? undefined : catalogSizeHint(catalog.data.books)}
          action={
            <>
              {catalog.data !== undefined && catalog.data.books > 0 ? (
                <Button onClick={() => goScope('catalog')}>Browse the whole catalog</Button>
              ) : null}
              <Button asChild variant="outline">
                <Link to="/books/new">Add a book</Link>
              </Button>
            </>
          }
        />
      ) : (
        <EmptyState
          title="No books match"
          hint={search.scope === 'catalog' ? 'Try a different search or clear the filters.' : 'The rest of the household’s catalog may have it.'}
          action={
            search.scope !== 'catalog' && search.set === undefined ? (
              <Button variant="outline" onClick={() => update({ scope: 'catalog' })}>
                Search the whole catalog
              </Button>
            ) : hasFacets(search) || search.q !== undefined ? (
              <Button variant="outline" onClick={() => update({ ...CLEAR_FACETS, q: undefined })}>
                Clear search and filters
              </Button>
            ) : undefined
          }
        />
      )}
    </PageBody>
  )
}
