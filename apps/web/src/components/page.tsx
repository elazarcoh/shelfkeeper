import { useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { titleForPath } from '@/components/shell/nav-model'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export function AuthCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  )
}

/**
 * Page padding 16/24/32px. "wide" for collections (max-w-6xl), "narrow" for forms and detail pages (max-w-2xl, centred).
 * A query container (`page`): a full-bleed bar inside a narrow column measures the page's width in cqw, which leaves out
 * a desktop scrollbar (100vw does not).
 */
export function PageBody({ width = 'wide', className, children }: { width?: 'wide' | 'narrow'; className?: string | undefined; children: ReactNode }) {
  return (
    <div className="@container/page px-4 py-4 md:px-6 md:py-6 lg:p-8">
      <div className={cn('mx-auto w-full min-w-0', width === 'wide' ? 'max-w-6xl' : 'max-w-2xl', className)}>{children}</div>
    </div>
  )
}

export function PageHeader({ title, description, actions }: { title: string; description?: string | undefined; actions?: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // Below lg the top bar already shows this title, so the page's own h1 stays for screen readers only.
  const repeatsTopBar = titleForPath(pathname) === title
  // With nothing else to show, the whole header collapses below lg (no empty gap above the content).
  const bare = repeatsTopBar && description === undefined && actions === undefined
  return (
    <div className={cn('mb-6 flex flex-wrap items-end justify-between gap-3 md:mb-8', bare && 'max-lg:mb-0')}>
      <div className="min-w-0">
        <h1 className={cn('text-2xl font-semibold tracking-tight break-words text-match-parent', repeatsTopBar && 'max-lg:sr-only')} dir="auto">
          {title}
        </h1>
        {description !== undefined ? (
          <p className="text-sm text-muted-foreground break-words text-match-parent" dir="auto">
            {description}
          </p>
        ) : null}
      </div>
      {actions !== undefined ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** Sections of a page: 32px apart, 40px from md. */
export function PageSections({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return <div className={cn('grid grid-cols-1 gap-8 md:gap-10', className)}>{children}</div>
}

export function PageSection({
  id,
  title,
  actions,
  children,
  className,
}: {
  id: string
  title: string
  actions?: ReactNode
  children: ReactNode
  className?: string | undefined
}) {
  return (
    <section aria-labelledby={id} className={cn('min-w-0', className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        {/* tabIndex -1: somewhere for focus to land when a removed row's control is gone */}
        <h2 id={id} tabIndex={-1} className="rounded-sm text-lg font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string | undefined; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-6 text-center md:p-10">
      <p className="font-medium">{title}</p>
      {hint !== undefined ? <p className="mt-1 text-sm text-muted-foreground">{hint}</p> : null}
      {action !== undefined ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  )
}
