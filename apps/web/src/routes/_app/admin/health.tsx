import { createFileRoute } from '@tanstack/react-router'
import { HealthPage } from '@/features/health/health-page'
import { parseHealthSearch } from '@/features/health/health-state'

export const Route = createFileRoute('/_app/admin/health')({
  validateSearch: parseHealthSearch,
  component: function HealthRoute() {
    const { check } = Route.useSearch()
    return <HealthPage check={check} />
  },
})
