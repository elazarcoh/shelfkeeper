import { Card, CardContent } from '@/components/ui/card'
import { GoalProgressBar } from '@/features/goals/goal-progress-bar'
import type { RouterOutputs } from '@/lib/trpc'

type Goal = RouterOutputs['goals']['mine'][number]

export function GoalProgress({ goals }: { goals: Goal[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {goals.map((g) => (
        <Card key={g.id}>
          <CardContent>
            <GoalProgressBar goal={g} />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
