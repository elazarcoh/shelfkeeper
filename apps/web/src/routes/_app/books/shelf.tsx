import { createFileRoute } from '@tanstack/react-router'
import { ShelfPage } from '@/features/shelf/shelf-page'

export const Route = createFileRoute('/_app/books/shelf')({ component: ShelfRoute })

function ShelfRoute() {
  const { user } = Route.useRouteContext()
  return <ShelfPage userId={user.id} />
}
