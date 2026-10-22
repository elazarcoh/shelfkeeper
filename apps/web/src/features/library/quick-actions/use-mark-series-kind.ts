import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { workKindLabel, type WorkKind } from '@mylib/domain'
import { trpc } from '@/lib/trpc'

/** "Mark series as…": sets the kind of the series' visible books and says how many changed. Shared by the series card and the series view. */
export function useMarkSeriesKind(seriesId: string): { mark: (kind: WorkKind) => Promise<void>; isPending: boolean } {
  const setSeriesKind = useMutation(trpc.catalog.setSeriesKind.mutationOptions())
  return {
    mark: async (kind) => {
      const { changed } = await setSeriesKind.mutateAsync({ seriesId, kind })
      toast(`Marked ${String(changed)} ${changed === 1 ? 'book' : 'books'} as ${workKindLabel[kind]}`)
    },
    isPending: setSeriesKind.isPending,
  }
}
