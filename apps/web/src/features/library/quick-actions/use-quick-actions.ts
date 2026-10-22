import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import type { ReadingStatus, SessionMode, WorkCard } from '@mylib/domain'
import { useInvalidateBook } from '@/features/book/invalidate'
import { todayLocal } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { editableSets, quickActionModel, type QuickAction, type QuickActionModel } from './quick-action-model'

export interface QuickActions {
  model: QuickActionModel
  run: (action: QuickAction) => void
  rate: (rating: number) => void
  pending: (id: string) => boolean
}

/** #85: a start also takes the book off Up next (queuePosition is where it was), and the toast says so */
const started = (mode: SessionMode, queuePosition: number | null) =>
  `${mode === 'listen' ? 'Started listening' : 'Started reading'}${queuePosition === null ? '' : ' · removed from Up next'}`
const marked = (mode: SessionMode) => (mode === 'listen' ? 'Marked as listened' : 'Marked as read')

/**
 * A Library card's quick actions. The work's sessions and sets load only once a menu or sheet is `open`; status,
 * Up next and rating come from the card. Merge only calls `onMerge`: its dialog lives outside the menu. Nothing is optimistic: each success refetches every view of the book.
 */
export function useQuickActions(card: WorkCard, isAdmin: boolean, open: boolean, onMerge: () => void): QuickActions {
  const invalidate = useInvalidateBook()
  const queryClient = useQueryClient()
  const workId = card.id
  const work = useQuery(trpc.catalog.get.queryOptions({ workId }, { enabled: open }))
  const sessions = useQuery(trpc.sessions.listForWork.queryOptions({ workId }, { enabled: open }))
  const sets = useQuery(trpc.sets.mine.queryOptions(undefined, { enabled: open }))

  const start = useMutation(trpc.sessions.start.mutationOptions())
  const markFinished = useMutation(trpc.sessions.markFinished.mutationOptions())
  const nextVolume = useMutation(trpc.sessions.nextVolume.mutationOptions())
  const complete = useMutation(trpc.sessions.complete.mutationOptions())
  const removeSession = useMutation(trpc.sessions.delete.mutationOptions())
  const setStatus = useMutation(trpc.tracking.setStatus.mutationOptions())
  const setRating = useMutation(trpc.tracking.setRating.mutationOptions())
  const queueAdd = useMutation(trpc.tracking.queueAdd.mutationOptions())
  const queueRemove = useMutation(trpc.tracking.queueRemove.mutationOptions())
  const queueRestore = useMutation(trpc.tracking.queueRestore.mutationOptions())
  const addToSet = useMutation(trpc.sets.addWork.mutationOptions())
  const removeFromSet = useMutation(trpc.sets.removeWork.mutationOptions())

  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())

  /** Runs one action: its item is disabled meanwhile; success refetches, failure toasts and changes nothing. */
  async function track<T>(id: string, job: () => Promise<T>): Promise<T | undefined> {
    setBusy((b) => new Set(b).add(id))
    try {
      const result = await job()
      invalidate()
      return result
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Something went wrong')
      return undefined
    } finally {
      setBusy((b) => {
        const next = new Set(b)
        next.delete(id)
        return next
      })
    }
  }

  /**
   * Undo of Start / Mark as read: deleting the session leaves status alone, so put the card's old status back, and
   * a start that took the book off Up next puts it back at `queuePosition` (#85).
   */
  function undoSession(sessionId: string, previous: ReadingStatus, queuePosition: number | null) {
    void track('undo', async () => {
      await removeSession.mutateAsync({ sessionId })
      try {
        await setStatus.mutateAsync({ workId, status: previous })
        if (queuePosition !== null) await queueRestore.mutateAsync({ workId, position: queuePosition })
      } catch (e) {
        invalidate() // the session is already gone: refetch even though restoring the status failed
        throw e
      }
    })
  }

  function withUndo(message: string, sessionId: string | undefined, previous: ReadingStatus, queuePosition: number | null = null) {
    if (sessionId === undefined) return
    toast(message, { action: { label: 'Undo', onClick: () => undoSession(sessionId, previous, queuePosition) } })
  }

  function rate(rating: number) {
    void track('rate', () => setRating.mutateAsync({ workId, rating }))
  }

  function run(a: QuickAction) {
    const today = todayLocal()
    const previous = card.status
    switch (a.kind) {
      case 'merge':
        onMerge()
        return
      case 'loading':
        return
      case 'start':
        void track(a.id, () => start.mutateAsync({ workId, editionId: null, mode: a.mode, startedOn: today, startedPrecision: 'day' })).then((result) =>
          result === undefined ? undefined : withUndo(started(a.mode, result.queuePosition), result.sessionId, previous, result.queuePosition),
        )
        return
      case 'markRead':
        void track(a.id, () =>
          markFinished.mutateAsync({ workId, editionId: null, mode: a.mode, finishedOn: today, finishedPrecision: 'unknown', rating: null }),
        ).then((id) => withUndo(marked(a.mode), id, previous))
        return
      case 'nextVolume':
        void track(a.id, () => nextVolume.mutateAsync({ sessionId: a.sessionId, editionId: a.editionId, today })).then((result) => {
          if (!result) return
          // finishing a volume counts toward stats and goals, which track() does not refetch
          for (const key of [trpc.stats.pathKey(), trpc.goals.pathKey()]) void queryClient.invalidateQueries({ queryKey: key })
          toast.success(result.moved ? `On to volume ${result.volume}` : `Waiting for volume ${result.waitingFor}`)
        })
        return
      case 'finish':
      case 'setAside': {
        const outcome = a.kind === 'finish' ? 'finished' : 'abandoned'
        // `true`: track() resolves undefined on failure, and complete's own result may be undefined too
        void track(a.id, async () => {
          await complete.mutateAsync({ sessionId: a.sessionId, completion: { outcome, finishedOn: today, finishedPrecision: 'day', fractionCompleted: null } })
          return true
        }).then((ok) => {
          if (ok) toast.success(a.kind === 'finish' ? 'Finished' : 'Set aside')
        })
        return
      }
      case 'status':
        void track(a.id, () => setStatus.mutateAsync({ workId, status: a.status }))
        return
      case 'queue':
        void track(a.id, () => (a.add ? queueAdd.mutateAsync({ workId, where: 'bottom' }) : queueRemove.mutateAsync({ workId })))
        return
      case 'clearRating':
        void track(a.id, async () => {
          await setRating.mutateAsync({ workId, rating: null })
          return true
        }).then((ok) => {
          if (ok) toast('Rating cleared', { action: { label: 'Undo', onClick: () => rate(a.previous) } })
        })
        return
      case 'set':
        void track(a.id, () => (a.checked ? removeFromSet.mutateAsync({ setId: a.setId, workId }) : addToSet.mutateAsync({ setId: a.setId, workId })))
        return
    }
  }

  const model = quickActionModel({
    isAdmin,
    status: card.status,
    inQueue: card.inQueue,
    rating: card.rating,
    formats: card.formats,
    // a refetch (after an action, while the menu was closed) leaves stale data: treat it as not loaded.
    // Not for sets: toggles keep the menu open, and a loading flash would drop focus mid-toggle
    inProgress: sessions.isFetching ? undefined : sessions.data
          ?.filter((s) => s.outcome === 'in_progress')
          .map((s) => ({ id: s.id, mode: s.mode, editionId: s.editionId, volume: s.progress.volume })),
    sessionsFailed: sessions.isError,
    editableSets: sets.data === undefined ? undefined : editableSets(sets.data, isAdmin),
    memberSetIds: work.data === undefined ? undefined : new Set(work.data.sets.map((s) => s.id)),
  })

  return { model, run, rate, pending: (id) => busy.has(id) }
}
