import { Link, useCanGoBack, useRouter, useRouterState } from '@tanstack/react-router'
import { ArrowLeft, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { usePalette } from '@/features/palette/palette-context'
import { goBack, isRootPath, titleForPath } from './nav-model'

/** Phones and tablets (below lg): title, Back on non-root pages, ＋ Add book. Sticky, clear of the notch. */
export function TopAppBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const { setOpen } = usePalette()
  const root = isRootPath(pathname)
  return (
    // border included, the bar is exactly --top-bar-h tall (plus the notch), so it matches --top-offset
    <header className="sticky top-0 z-40 border-b bg-background/95 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] backdrop-blur lg:hidden">
      <div className="flex h-[calc(var(--top-bar-h)-1px)] items-center gap-1 px-2">
        {root ? (
          <span aria-hidden className="w-2" />
        ) : (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back"
            className="size-11"
            onClick={() => {
              goBack({
                pathname,
                canGoBack,
                back: () => {
                  router.history.back()
                },
                navigate: (to) => void router.navigate({ to }),
              })
            }}
          >
            <ArrowLeft className="size-5" />
          </Button>
        )}
        <p className="min-w-0 flex-1 truncate px-2 text-base font-semibold">{titleForPath(pathname)}</p>
        <Button variant="ghost" size="icon" className="size-11" aria-label="Search" onClick={() => setOpen(true)}>
          <Search className="size-5" />
        </Button>
        {pathname !== '/books/new' ? (
          <Button asChild variant="ghost" size="icon" className="size-11">
            <Link to="/books/new" aria-label="Add book">
              <Plus className="size-5" />
            </Link>
          </Button>
        ) : null}
      </div>
    </header>
  )
}
