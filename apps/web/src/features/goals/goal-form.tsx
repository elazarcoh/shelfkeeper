import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { goalMetrics, type GoalMetric } from '@mylib/domain'
import { Field } from '@/components/field'
import { NativeSelect } from '@/components/native-select'
import { focusAfterRemoval } from '@/components/removal-focus'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { periodLabel } from '@/features/stats/stats-view'
import { formatNumber } from '@/lib/format'
import { trpc } from '@/lib/trpc'

const metricLabel: Record<GoalMetric, string> = { books: 'Books', hours: 'Hours', words: 'Words', pages: 'Pages' }

const GOALS_HEADING_ID = 'goals-heading'

export function GoalsCard() {
  const queryClient = useQueryClient()
  const refresh = () => void queryClient.invalidateQueries({ queryKey: trpc.goals.pathKey() })
  const goals = useQuery(trpc.goals.mine.queryOptions())
  const create = useMutation(trpc.goals.create.mutationOptions({ onSuccess: refresh }))
  const remove = useMutation(trpc.goals.delete.mutationOptions({ onSuccess: refresh }))

  const [year, setYear] = useState(new Date().getFullYear())
  const [metric, setMetric] = useState<GoalMetric>('books')
  const [target, setTarget] = useState(12)

  return (
    <Card>
      <CardHeader>
        {/* tabIndex -1: where focus lands when the last goal is removed */}
        <CardTitle id={GOALS_HEADING_ID} tabIndex={-1} className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          Reading goals
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ul className="grid gap-2">
          {(goals.data ?? []).map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0">
                {metricLabel[g.metric]} — {periodLabel(g.periodStart, g.periodEnd)}: {formatNumber(g.total)} / {formatNumber(g.target)}
              </span>
              {/* aria-disabled, not disabled, while a removal is pending: focus moves on to the next goal's button, and a
                  disabled button could not take it */}
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Remove goal: ${metricLabel[g.metric]} ${periodLabel(g.periodStart, g.periodEnd)}`}
                aria-disabled={remove.isPending ? 'true' : undefined}
                className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                data-goal-remove
                onClick={(e) => {
                  if (remove.isPending) return
                  const restore = focusAfterRemoval(e.currentTarget, '[data-goal-remove]', GOALS_HEADING_ID)
                  remove.mutate({ goalId: g.id }, { onError: restore })
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
          {goals.data && goals.data.length === 0 ? <li className="text-muted-foreground">No goals yet.</li> : null}
        </ul>
        {/* a rule between the goals and the form for a new one; phones: Target and Year share a row, the button
            sits at the start like the other cards' buttons */}
        <div className="grid grid-cols-2 gap-3 border-t pt-4 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
          <div className="col-span-2 sm:col-span-1">
            <Field label="Metric" htmlFor="goal-metric">
              <NativeSelect id="goal-metric" value={metric} onChange={(e) => setMetric(e.target.value as GoalMetric)}>
                {goalMetrics.map((m) => (
                  <option key={m} value={m}>
                    {metricLabel[m]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Field label="Target" htmlFor="goal-target">
            <Input id="goal-target" type="number" inputMode="numeric" min={1} value={target} onChange={(e) => setTarget(Number(e.target.value))} />
          </Field>
          <Field label="Year" htmlFor="goal-year">
            <Input id="goal-year" type="number" inputMode="numeric" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </Field>
          <Button
            className="col-span-2 justify-self-start sm:col-span-1"
            disabled={create.isPending || !(target > 0) || !Number.isInteger(year) || year < 1900 || year > 2999}
            onClick={() => create.mutate({ periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, metric, target })}
          >
            Add goal
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
