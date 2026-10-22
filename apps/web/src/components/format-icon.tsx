import { BookOpen, Headphones, TabletSmartphone } from 'lucide-react'
import type { EditionFormat } from '@mylib/domain'
import { formatLabel } from '@/lib/format'

const icons = { physical: BookOpen, ebook: TabletSmartphone, audiobook: Headphones } as const

export function FormatIcon({ format, className }: { format: EditionFormat; className?: string | undefined }) {
  const Icon = icons[format]
  return <Icon className={className ?? 'size-4'} aria-label={formatLabel[format]} role="img" />
}
