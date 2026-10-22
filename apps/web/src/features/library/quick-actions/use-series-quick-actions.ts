import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { type ReadingStatus, type SeriesGroupCard } from '@mylib/domain'
import { useInvalidateBook } from '@/features/book/invalidate'
import { todayLocal } from '@/lib/format'
import { trpc } from '@/lib/trpc'
import { editableSets, type SetAction } from './quick-action-model'
import { useMarkSeriesKind } from './use-mark-series-kind'
import { seriesActionModel, type KindAction, type SeriesAction, type SeriesActionModel } from './series-action-model'

export interface SeriesQuickActions {
  model: SeriesActionModel
  run: (action: SeriesAction | SetAction | KindAction) => void
  pending: (id: string) => boolean
}

interface Done {
  workId: string
  sessionId: string
  previous: ReadingStatus
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong')

/**
 * A Library series card's quick actions. The series' books and the user's sets load only once a menu or sheet is
 * `open`. Nothing is optimistic: each run refetches every view of the books once, at its end.
 */
export function useSeriesQuickActions(group: SeriesGroupCard, isAdmin: boolean, open: boolean): SeriesQuickActions {
  const invalidate = useInvalidateBook()
  const entries = useQuery(trpc.series.entries.queryOptions({ seriesId: group.id }, { enabled: open }))
  const sets = useQuery(trpc.sets.mine.queryOptions(undefined, { enabled: open }))
  const workIds = entries.data?.map((e) => e.id)
  const membership = useQuery(trpc.sets.membership.queryOptions({ workIds: workIds ?? [] }, { enabled: open && workIds !== undefined }))
  const hidden = useQuery(trpc.series.hiddenContinuations.queryOptions(undefined, { enabled: open }))

  const markFinished = useMutation(trpc.sessions.markFinished.mutationOptions())
  const removeSession = useMutation(trpc.sessions.delete.mutationOptions())
  const setStatus = useMutation(trpc.tracking.setStatus.mutationOptions())
  const queueAdd = useMutation(trpc.tracking.queueAdd.mutationOptions())
  const addToSet = useMutation(trpc.sets.addWork.mutationOptions())
  const removeFromSet = useMutation(trpc.sets.removeWork.mutationOptions())
  const markSeriesKind = useMarkSeriesKind(group.id)
  const setContinuationHidden = useMutation(trpc.series.setContinuationHidden.mutationOptions())

  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())

  /** Runs one action: its item is disabled meanwhile; one refetch at the end, whether or not it all worked. */
  async function track(id: string, job: () => Promise<void>): Promise<void> {
    setBusy((b) => new Set(b).add(id))
    try {
      await job()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      invalidate()
      setBusy((b) => {
        const next = new Set(b)
        next.delete(id)
        return next
      })
    }
  }

  /** Undo of Mark all as read: deleting a session leaves status alone, so put each book's old status back. */
  function undoAll(done: readonly Done[]) {
    void track('undo', async () => {
      for (const d of done) {
        await removeSession.mutateAsync({ sessionId: d.sessionId })
        await setStatus.mutateAsync({ workId: d.workId, status: d.previous })
      }
    })
  }

  async function markAll(targets: Extract<SeriesAction, { kind: 'markAll' }>['targets']) {
    const today = todayLocal()
    const done: Done[] = []
    try {
      for (const t of targets) {
        const sessionId = await markFinished.mutateAsync({
          workId: t.workId,
          editionId: null,
          mode: t.mode,
          finishedOn: today,
          finishedPrecision: 'unknown',
          rating: null,
        })
        done.push({ workId: t.workId, sessionId, previous: t.previous })
      }
    } catch (e) {
      toast.error(errorMessage(e)) // the books already marked still get their Undo, below
    }
    if (done.length > 0) {
      const n = done.length
      toast(`Marked ${String(n)} ${n === 1 ? 'book' : 'books'} as read`, { action: { label: 'Undo', onClick: () => undoAll(done) } })
    }
  }

  function run(a: SeriesAction | SetAction | KindAction) {
    switch (a.kind) {
      case 'loading':
      case 'info':
        return
      case 'queue':
        void track(a.id, async () => {
          await queueAdd.mutateAsync({ workId: a.workId, where: 'bottom' })
        })
        return
      case 'markAll':
        void track(a.id, () => markAll(a.targets))
        return
      case 'markKind':
        void track(a.id, () => markSeriesKind.mark(a.workKind))
        return
      case 'continuation':
        void track(a.id, async () => {
          await setContinuationHidden.mutateAsync({ seriesId: group.id, hidden: a.hidden })
        })
        return
      case 'set':
        void track(a.id, async () => {
          const books = entries.data ?? []
          const inSet = new Set(membership.data?.filter((m) => m.setId === a.setId).map((m) => m.workId))
          if (a.checked) for (const e of books) await removeFromSet.mutateAsync({ setId: a.setId, workId: e.id })
          else for (const e of books) if (!inSet.has(e.id)) await addToSet.mutateAsync({ setId: a.setId, workId: e.id })
        })
        return
    }
  }

  const model = seriesActionModel({
    // a refetch (after an action, while the menu was closed) leaves stale data: treat it as not loaded.
    // Not for membership: toggles keep the menu open, and a loading flash would drop focus mid-toggle
    entries: entries.isFetching ? undefined : entries.data,
    entriesFailed: entries.isError,
    entryIds: workIds,
    editableSets: sets.data === undefined ? undefined : editableSets(sets.data, isAdmin),
    membership: membership.data,
    continuationHidden: hidden.isFetching || hidden.data === undefined ? undefined : hidden.data.includes(group.id),
  })

  return { model, run, pending: (id) => busy.has(id) }
}
