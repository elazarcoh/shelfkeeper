import { Feather, Globe, type LucideIcon } from 'lucide-react'
import { workKindLabel, type WorkKind } from '@mylib/domain'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const icons: Partial<Record<WorkKind, LucideIcon>> = { fanfiction: Feather, web_serial: Globe }

/** Fanfiction and web serials are marked; a plain book shows nothing. Compact is the icon alone, for tight cards. */
export function KindBadge({ kind, compact = false, className }: { kind: WorkKind; compact?: boolean | undefined; className?: string | undefined }) {
  if (kind === 'book') return null
  const Icon = icons[kind]
  // a kind a newer server sent to a cached client
  if (!Icon) return null
  const label = workKindLabel[kind]
  if (compact) {
    return (
      <span role="img" aria-label={label} title={label} className={cn('inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm ring-1 ring-border', className)}>
        <Icon className="size-3" aria-hidden />
      </span>
    )
  }
  return (
    <Badge variant="outline" className={className}>
      <Icon size={14} aria-hidden />
      {label}
    </Badge>
  )
}
