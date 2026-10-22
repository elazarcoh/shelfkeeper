import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { trpc } from './trpc'
import { clearCopy } from '@/features/offline/offline-store'

export function useLogout() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation(
    trpc.auth.logout.mutationOptions({
      onSuccess: () => {
        void clearCopy()
        queryClient.clear()
        void navigate({ to: '/login' })
      },
    }),
  )
}
