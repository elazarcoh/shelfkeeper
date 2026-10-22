import { useQuery } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { findVolumeGroups, parseVolumesAnswer, VOLUMES_PROMPT_MAX, volumesPrompts, type VolumeGroup } from '@mylib/domain'
import { EmptyState } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { safeStorage } from '@/features/shelf/capture-target'
import { copyText } from '@/lib/copy-text'
import { trpc } from '@/lib/trpc'
import { GroupCard } from './group-card'
import { loadDismissed, saveDismissed, shownGroups } from './volumes-state'

export function VolumesPage({ userId }: { userId: string }) {
  const catalog = useQuery(trpc.admin.volumes.catalog.queryOptions())
  const entries = useMemo(() => catalog.data ?? [], [catalog.data])
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed(safeStorage(), userId))
  const [aiGroups, setAiGroups] = useState<VolumeGroup[]>([])
  const [answer, setAnswer] = useState('')
  const [answerError, setAnswerError] = useState<string | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [copyFailed, setCopyFailed] = useState(false)
  const promptArea = useRef<HTMLTextAreaElement>(null)
  const promptDetails = useRef<HTMLDetailsElement>(null)

  const appGroups = useMemo(() => findVolumeGroups(entries), [entries])
  const { prompts, omitted } = useMemo(() => volumesPrompts(entries), [entries])
  const shown = useMemo(() => shownGroups(appGroups, aiGroups, dismissed, new Set(entries.map((e) => e.id))), [appGroups, aiGroups, dismissed, entries])
  const shownApp = shown.filter((g) => g.source === 'app')
  const shownAi = shown.filter((g) => g.source === 'ai')

  function dismiss(key: string) {
    const next = new Set(dismissed).add(key)
    setDismissed(next)
    saveDismissed(safeStorage(), userId, next)
  }

  async function copyPrompt(prompt: string) {
    // plain http has no Clipboard API: the fallback selects the textarea, which must be rendered, so open it now (synchronously, in the click)
    if (!window.isSecureContext && promptDetails.current) promptDetails.current.open = true
    if (await copyText(prompt, promptArea.current)) {
      toast.success('Prompt copied')
    } else {
      setCopyFailed(true)
      if (promptDetails.current) promptDetails.current.open = true
    }
  }

  function readAnswer() {
    const result = parseVolumesAnswer(answer, entries, [...appGroups, ...aiGroups])
    if (!result.ok) {
      setAnswerError(result.error)
      setNotes([])
      return
    }
    setAnswerError(null)
    setNotes(result.value.notes)
    setAiGroups((current) => [...current, ...result.value.groups])
    setAnswer('')
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="max-w-prose text-sm text-muted-foreground">Books that are really volumes of one book: review each group and merge it into one book with volumes.</p>

      <Card>
        <CardHeader>
          <CardTitle>1 · Found by the app</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          {catalog.isPending ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {catalog.error ? (
            <p role="alert" className="text-sm text-destructive">
              {catalog.error.message}
            </p>
          ) : null}
          {catalog.data ? shownApp.map((g) => <GroupCard key={g.key} group={g} entries={entries} onDismiss={dismiss} />) : null}
          {catalog.data && shownApp.length === 0 ? <EmptyState title="No books look like volumes of one book." /> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2 · Ask an AI</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <p>Copy the prompt, send it to your own AI, then paste its answer below.</p>
          <div className="flex flex-wrap gap-2">
            {prompts.map((p, i) => (
              <Button key={i} type="button" disabled={catalog.data === undefined} onClick={() => void copyPrompt(p)}>
                {prompts.length === 1 ? 'Copy prompt' : `Copy prompt ${String(i + 1)} of ${String(prompts.length)}`}
              </Button>
            ))}
          </div>
          {omitted > 0 ? <p className="text-muted-foreground">The prompt covers the first {VOLUMES_PROMPT_MAX.toLocaleString('en-US')} books by title.</p> : null}
          <details ref={promptDetails}>
            <summary className="cursor-pointer">Show the prompt</summary>
            {copyFailed ? <p className="mt-2 text-xs text-muted-foreground">Select the prompt and copy it</p> : null}
            <Textarea ref={promptArea} readOnly dir="ltr" aria-label="The prompt" value={prompts.join('\n\n')} className="mt-2 text-xs" onFocus={(e) => e.currentTarget.select()} />
          </details>
          <div className="grid gap-1.5">
            <Label htmlFor="volumes-answer">The AI's answer</Label>
            <Textarea id="volumes-answer" dir="auto" rows={5} value={answer} onChange={(e) => setAnswer(e.target.value)} />
          </div>
          <div>
            <Button type="button" disabled={answer.trim() === '' || catalog.data === undefined} onClick={readAnswer}>
              Read the answer
            </Button>
          </div>
          {answerError !== null ? (
            <p role="alert" className="text-destructive" dir="auto">
              {answerError}
            </p>
          ) : null}
          {notes.map((n, i) => (
            <p key={i} className="text-muted-foreground" dir="auto">
              {n}
            </p>
          ))}
        </CardContent>
      </Card>

      {shownAi.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>From the AI</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {shownAi.map((g) => (
              <GroupCard key={g.key} group={g} entries={entries} onDismiss={dismiss} />
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
