import { createFileRoute } from '@tanstack/react-router'
import { SeriesAdminPage } from '@/features/series-admin/series-admin-page'

export const Route = createFileRoute('/_app/admin/series')({ component: SeriesAdminPage })
