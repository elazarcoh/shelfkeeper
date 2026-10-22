import { createFileRoute } from '@tanstack/react-router'
import { VolumesPage } from '@/features/volumes/volumes-page'

export const Route = createFileRoute('/_app/admin/volumes')({ component: VolumesRoute })

function VolumesRoute() {
  const { user } = Route.useRouteContext()
  return <VolumesPage userId={user.id} />
}
