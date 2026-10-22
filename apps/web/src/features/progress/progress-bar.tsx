import { cn } from '@/lib/utils'

/** A thin, unlabeled-on-screen progress bar; the label is for screen readers (e.g. "Progress in Dune"). */
export function ProgressBar({ fraction, label, className }: { fraction: number; label: string; className?: string | undefined }) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100)
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent}%`}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
    </div>
  )
}
