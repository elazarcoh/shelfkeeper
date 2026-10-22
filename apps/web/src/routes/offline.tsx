import { createFileRoute } from '@tanstack/react-router'
import { OfflinePage } from '@/features/offline/offline-page'

// outside _app: it must open without the server, which _app asks who is signed in
export const Route = createFileRoute('/offline')({ component: OfflinePage })
