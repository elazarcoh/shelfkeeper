import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Field } from '@/components/field'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { withBase } from '@/lib/base-path'
import { trpc, trpcClient } from '@/lib/trpc'
import { canConfirmRestore } from './backup-view'
import { decideHandoff, FAST_DEADLINE_MS, FAST_POLL_MS, shouldContinue, type HandoffState, type PollStatus } from './restore-handoff'

export type RestoreSource = { kind: 'file'; name: string } | { kind: 'upload'; uploadId: string }

/** The one thing that decides the hand-off (ruling R9) is `decideHandoff` in ./restore-handoff, which is
 * pure and unit-tested on its own; everything here is just wiring it to `fetch`, a timer and the browser's
 * visibility state. The fast poll (and the slow one past its deadline) skip real requests while the tab
 * is hidden -- there is nothing to show the admin meanwhile, and no reason to keep polling a backgrounded tab. */
async function checkMaintenance(): Promise<PollStatus> {
  try {
    const res = await fetch(withBase('/maintenance/status'), { cache: 'no-store' })
    const body = (await res.json()) as { maintenance: unknown }
    return body.maintenance !== null ? 'maintenance' : 'not-yet'
  } catch {
    return 'poll-error'
  }
}

/** Only asked once the fast poll's deadline passes: a fresh failure recorded while this attempt was
 * waiting to enter maintenance -- `at` no older than `since` rules out a stale one from an earlier attempt. */
async function checkRestoreFailure(since: number): Promise<string | null> {
  const outcome = await trpcClient.backups.lastRestore.query().catch(() => null)
  return outcome && !outcome.ok && new Date(outcome.at).getTime() >= since ? outcome.error : null
}

export function RestoreDialog({ source, label, trigger }: { source: RestoreSource; label: string; trigger: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [handoff, setHandoff] = useState<HandoffState | null>(null)
  // Fix round 2: `mounted` and "this attempt is still the current one" are two different things, and
  // conflating them (a single ref reset to false on unmount, then set back to false -- i.e. "not
  // cancelled" -- in a later `onSuccess`) is exactly the bug that round 1 introduced: a restore mutation
  // that resolves after the dialog (or the whole page) has gone away would revive polling and could
  // navigate a page the admin already left. `mounted` only ever goes true -> false, never back; `attempt`
  // is a token each restore attempt captures when it starts, bumped again whenever it is superseded.
  const mountedRef = useRef(true)
  const attemptRef = useRef(0)
  const sinceRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const queryClient = useQueryClient()

  useEffect(() => {
    // StrictMode (apps/web/src/main.tsx) double-invokes effects in dev: mount -> cleanup -> mount again.
    // Setting this only in the cleanup would leave it false forever after that synthetic first pass --
    // the real, lasting mount needs to set it back to true, or every restore in dev would bail at once.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(timerRef.current)
    }
  }, [])

  async function tick(attempt: number): Promise<void> {
    if (!shouldContinue(mountedRef.current, attempt, attemptRef.current)) return
    const elapsedMs = Date.now() - sinceRef.current
    const hidden = typeof document !== 'undefined' && document.hidden
    const status = hidden ? 'not-yet' : await checkMaintenance()
    if (!shouldContinue(mountedRef.current, attempt, attemptRef.current)) return
    const restoreFailure = !hidden && elapsedMs >= FAST_DEADLINE_MS ? await checkRestoreFailure(sinceRef.current) : null
    if (!shouldContinue(mountedRef.current, attempt, attemptRef.current)) return
    const decision = decideHandoff({ elapsedMs, status, restoreFailure, cancelled: false }, withBase('/admin/backups'))
    setHandoff(decision)
    if (decision.phase === 'navigate') {
      window.location.assign(decision.url)
      return
    }
    if (decision.phase === 'failed') {
      void queryClient.invalidateQueries({ queryKey: trpc.backups.pathKey() })
      void queryClient.invalidateQueries({ queryKey: trpc.system.pathKey() })
      return
    }
    if (decision.phase === 'starting' || decision.phase === 'still-starting') {
      timerRef.current = setTimeout(() => void tick(attempt), decision.pollIntervalMs)
    }
  }

  const restore = useMutation(
    trpc.backups.restore.mutationOptions({
      onSuccess: () => {
        // this callback fires whenever the mutation resolves, mount or not -- bail immediately rather
        // than starting a new attempt (and, via it, a poll loop) for a component nothing shows anymore
        if (!mountedRef.current) return
        const attempt = ++attemptRef.current
        sinceRef.current = Date.now()
        setHandoff({ phase: 'starting', pollIntervalMs: FAST_POLL_MS })
        void tick(attempt)
      },
    }),
  )

  const waiting = handoff?.phase === 'starting' || handoff?.phase === 'still-starting'
  const busy = restore.isPending || waiting
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        // supersede anything still in flight for a previous attempt, whether or not a new one follows
        attemptRef.current++
        if (next) {
          setTyped('')
          setHandoff(null)
        }
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Restore this backup?</DialogTitle>
          <DialogDescription>
            Everything in My Library goes back to {label}. The current state is backed up first, and the app shows a maintenance page for a few minutes.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (canConfirmRestore(typed) && !busy) restore.mutate({ source, confirm: 'restore' })
          }}
        >
          <Field label='Type "restore" to confirm' htmlFor="restore-confirm">
            <Input id="restore-confirm" autoComplete="off" disabled={busy} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </Field>
          {handoff?.phase === 'still-starting' ? (
            <p className="text-sm text-muted-foreground">The restore is still starting — this page will switch to the maintenance screen when it begins.</p>
          ) : null}
          {handoff?.phase === 'failed' ? (
            <p className="break-words text-sm text-destructive" dir="auto">
              The restore did not start: {handoff.reason}. Nothing was changed; check the list below and try again.
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" variant="destructive" disabled={!canConfirmRestore(typed) || busy}>
              {restore.isPending ? 'Checking the backup…' : handoff?.phase === 'still-starting' ? 'Still starting…' : waiting ? 'Starting restore…' : 'Restore'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
