import { createFileRoute } from '@tanstack/react-router'
import { PeoplePage } from '@/features/people/people-page'

export const Route = createFileRoute('/_app/admin/authors')({ component: PeoplePage })
