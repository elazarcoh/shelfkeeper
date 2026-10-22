import { expectedProgress, goalPace, type GoalMetric, type GoalPace } from '@mylib/domain'
import { CircleCheck, TrendingDown, TrendingUp } from 'lucide-react'
import { goalAmountText, periodLabel, periodNoun, shortDate } from '@/features/stats/stats-view'
import { todayLocal } from '@/lib/format'
import type { RouterOutputs } from '@/lib/trpc'

type Goal = RouterOutputs['goals']['mine'][number]

const metricName: Record<GoalMetric, string> = { books: 'Books', hours: 'Hours', words: 'Words', pages: 'Pages' }
const paceText: Record<GoalPace, { label: string; Icon: typeof TrendingUp }> = {
  ahead: { label: 'Ahead of pace', Icon: TrendingUp },
  behind: { label: 'Behind pace', Icon: TrendingDown },
  on_track: { label: 'On pace', Icon: CircleCheck },
}

/** "Books · October 2026" */
export const goalLabel = (goal: Pick<Goal, 'metric' | 'periodStart' | 'periodEnd'>): string =>
  `${metricName[goal.metric]} · ${periodLabel(goal.periodStart, goal.periodEnd)}`

/** A goal's progress bar with a marker where even pacing would be by today, and whether it's ahead or behind. */
export function GoalProgressBar({ goal, label = goalLabel(goal) }: { goal: Goal; label?: string }) {
  const today = todayLocal()
  const expected = expectedProgress(goal.periodStart, goal.periodEnd, today)
  const pace = goalPace(goal.progress, expected)
  const noun = periodNoun(goal.periodStart, goal.periodEnd)
  const done = goal.progress >= 1
  const timing =
    today < goal.periodStart
      ? `starts ${shortDate(goal.periodStart, true)}`
      : expected >= 1
        ? `${noun} is over`
        : `${Math.round(expected * 100)}% of ${noun} gone`
  const { label: paceLabel, Icon } = done ? { label: 'Goal reached', Icon: CircleCheck } : paceText[pace]
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground tabular-nums">{goalAmountText(goal.metric, goal.total, goal.target)}</span>
      </div>
      <div
        className="relative h-2 rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(goal.progress * 100)}
        aria-valuetext={`${goalAmountText(goal.metric, goal.total, goal.target)}; ${paceLabel.toLowerCase()}, ${timing}`}
      >
        <div className="viz-grow-x h-2 rounded-full bg-primary" style={{ width: `${Math.round(goal.progress * 100)}%` }} />
        {expected > 0 && expected < 1 ? (
          <div
            className="absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-full bg-foreground/70"
            style={{ insetInlineStart: `${Math.round(expected * 100)}%` }}
            title="Where an even pace would be today"
          />
        ) : null}
      </div>
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <Icon aria-hidden className="size-3.5" />
        <span className="font-medium text-foreground">{paceLabel}</span>
        <span aria-hidden>·</span>
        <span>{timing}</span>
      </p>
    </div>
  )
}
