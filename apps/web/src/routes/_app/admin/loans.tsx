import { createFileRoute, redirect } from '@tanstack/react-router'

/** The household loans list moved out of Admin to "Who has my books" (#57); old links still land there. */
export const Route = createFileRoute('/_app/admin/loans')({
  beforeLoad: () => {
    throw redirect({ to: '/loans', replace: true })
  },
})
