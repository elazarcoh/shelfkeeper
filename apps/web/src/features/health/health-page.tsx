import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { healthChecks, type HealthCheck } from '@mylib/domain'
import { LoadMore } from '@/components/load-more'
import { EmptyState } from '@/components/page'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { todayLocal } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { AbsPushPanel } from './abs-push-panel'
import { HealthRow } from './health-row'
import { checkLabel, defaultCheck } from './health-state'

const PAGE = 50

export function HealthPage({ check: picked }: { check: HealthCheck | undefined }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const today = todayLocal()
  const counts = useQuery(trpc.admin.health.counts.queryOptions({ today }))
  const check = picked ?? defaultCheck(counts.data)
  const [limit, setLimit] = useState(PAGE)
  const [showIgnored, setShowIgnored] = useState(false)
  const switchId = useId()
  // the Audiobookshelf check has its own panel and endpoint; the generic list is for the SQL checks
  const sqlCheck = check === 'abs_out_of_sync' ? undefined : check
  const list = useQuery({ ...trpc.admin.health.list.queryOptions({ check: sqlCheck ?? 'no_cover', today, limit, showIgnored }),
    placeholderData: keepPreviousData,
    // Without ?check=, wait for the counts so the first list request is for the check we will show.
    enabled: sqlCheck !== undefined && (picked !== undefined || counts.data !== undefined),
  })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: trpc.admin.health.pathKey() })

  function pick(next: HealthCheck) {
    setLimit(PAGE)
    void navigate({ to: '/admin/health', search: { check: next }, replace: true })
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="max-w-prose text-sm text-muted-foreground">What is missing or looks wrong in the catalog. Fix a row from its book, or ignore it if it is fine as it is.</p>
      <div role="tablist" aria-label="Checks" className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:flex-wrap md:px-0">
        {healthChecks.map((c) => {
          const n = counts.data?.[c]
          return (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={c === check}
              onClick={() => pick(c)}
              className={`flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-3 text-sm ${c === check ? 'border-primary bg-primary text-primary-foreground' : n === 0 ? 'text-muted-foreground' : ''}`}
            >
              {checkLabel[c]}
              <span className="tabular-nums">{n === undefined ? '…' : String(n)}</span>
            </button>
          )
        })}
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id={switchId}
          checked={showIgnored}
          onCheckedChange={(v) => {
            setShowIgnored(v)
            setLimit(PAGE)
          }}
        />
        <Label htmlFor={switchId}>Show ignored</Label>
      </div>
      {counts.error ? (
        <p role="alert" className="text-sm text-destructive">
          {counts.error.message}
        </p>
      ) : null}
      {sqlCheck === undefined ? <AbsPushPanel showIgnored={showIgnored} /> : null}
      {sqlCheck !== undefined && list.isPending ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {sqlCheck !== undefined && list.error ? (
        <p role="alert" className="text-sm text-destructive">
          {list.error.message}
        </p>
      ) : null}
      {sqlCheck !== undefined && list.data ? (
        list.data.items.length === 0 ? (
          <EmptyState title={showIgnored ? 'Nothing ignored here.' : 'Nothing to fix here.'} />
        ) : (
          <ul aria-label={checkLabel[check]} className="grid grid-cols-1 gap-2">
            {list.data.items.map((item) => (
              <HealthRow key={item.key} item={item} ignored={showIgnored} onChanged={refresh} />
            ))}
          </ul>
        )
      ) : null}
      {sqlCheck !== undefined && list.data?.more ? <LoadMore loading={list.isFetching} failed={list.isError} onMore={() => setLimit((l) => l + PAGE)} /> : null}
    </div>
  )
}
