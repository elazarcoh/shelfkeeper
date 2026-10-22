import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { WhatNextFormat, WhatNextMood } from '@mylib/domain'
import { PageSection } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { copyText } from '@/lib/copy-text'
import { seriesLabel, todayLocal } from '@/lib/format'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { PickRow, type PickRowData } from './pick-row'

type Parsed = RouterOutputs['whatNext']['parseAnswer']['picks'][number]

function rowData(pick: Parsed): PickRowData {
  return {
    title: pick.title,
    authors: pick.authors,
    series: pick.series === null ? null : seriesLabel({ name: pick.series, position: pick.position }),
    firstUnread: null,
    pages: null,
    audioSec: null,
    reason: pick.reason,
    coverAssetId: null,
    imageUrl: null,
    workId: null,
    owned: null,
    audiobook: null,
    kind: pick.kind,
    note: pick.format_note,
  }
}

/** Copy a prompt for the person's own AI, paste its JSON answer back, and get picks the library can check against what was read. */
export function AskAiPanel({ mood, format, saved }: { mood: WhatNextMood; format: WhatNextFormat; saved: string | null }) {
  const queryClient = useQueryClient()
  const promptArea = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(saved ?? '')
  const [wished, setWished] = useState<ReadonlySet<number>>(new Set())
  // the page's saved answer (and its Wishlist marks) is cached with the view: refetch it after each change
  const refetchView = () => queryClient.invalidateQueries({ queryKey: trpc.whatNext.get.pathKey() })
  const parse = useMutation(trpc.whatNext.parseAnswer.mutationOptions({ onSuccess: (_data, vars) => (vars.save === false ? undefined : refetchView()), meta: { inlineError: true } }))
  const clear = useMutation(trpc.whatNext.clearAnswer.mutationOptions({ onSuccess: refetchView, onError: (e) => toast.error(e.message) }))
  const wish = useMutation(
    trpc.whatNext.wish.mutationOptions({
      onSuccess: () => {
        toast.success('Added to your wishlist')
        void queryClient.invalidateQueries({ queryKey: trpc.wishlist.pathKey() })
        void refetchView()
      },
      onError: (e) => toast.error(e.message),
    }),
  )

  // the saved answer comes back as picks on load (it is read again, which also marks what is on the Wishlist now)
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || saved === null) return
    restored.current = true
    // read again without saving; an answer that no longer reads stays in the box, and only Show picks reports it
    parse.mutate({ text: saved, save: false }, { onError: () => parse.reset() })
  }, [saved, parse])

  async function copyPrompt() {
    const { prompt } = await queryClient.query({ ...trpc.whatNext.prompt.queryOptions({ mood, format, today: todayLocal() }), staleTime: 0 })
    // plain http has no Clipboard API: the fallback selects the textarea, which holds the prompt for that moment
    if (await copyText(prompt, promptArea.current)) toast.success('Prompt copied')
    else toast.error('Could not copy: select the prompt below and copy it')
  }

  function show() {
    setWished(new Set())
    parse.mutate({ text })
  }

  function reset() {
    setText('')
    setWished(new Set())
    parse.reset()
    clear.mutate()
  }

  const picks = parse.data?.picks ?? []
  return (
    <PageSection id="next-ask-ai" title="Ask AI">
      <div className="grid gap-3 text-sm">
        <p className="text-muted-foreground">Copy the prompt to Claude or Gemini, then paste its answer here. Picks you already read are left out.</p>
        <div>
          <Button type="button" variant="outline" onClick={() => void copyPrompt()}>
            Copy prompt
          </Button>
        </div>
        {/* a plain textarea: the Textarea component's w-full would beat sr-only's 1px width and widen the page */}
        <textarea ref={promptArea} readOnly aria-hidden tabIndex={-1} className="sr-only" />
        <div className="grid gap-1.5">
          <Label htmlFor="next-answer">Paste the AI's answer</Label>
          <Textarea id="next-answer" dir="auto" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={text.trim() === '' || parse.isPending} onClick={show}>
            Show picks
          </Button>
          <Button type="button" variant="ghost" disabled={text === '' && parse.data === undefined} onClick={reset}>
            Clear
          </Button>
        </div>
        {parse.error ? (
          <p role="alert" className="text-destructive" dir="auto">
            {parse.error.message}
          </p>
        ) : null}
        {parse.data && parse.data.alreadyRead > 0 ? (
          <p className="text-muted-foreground">{parse.data.alreadyRead === 1 ? "1 pick you've already read was left out" : `${String(parse.data.alreadyRead)} picks you've already read were left out`}</p>
        ) : null}
        {parse.data && parse.data.unusable > 0 ? (
          <p className="text-muted-foreground">{parse.data.unusable === 1 ? "1 item couldn't be used" : `${String(parse.data.unusable)} items couldn't be used`}</p>
        ) : null}
        {picks.length > 0 ? (
          <ul className="divide-y rounded-lg border">
            {picks.map((pick, i) => (
              <PickRow key={`${String(i)}|${pick.title}`} data={rowData(pick)}>
                {pick.onWishlist || wished.has(i) ? (
                  <Badge variant="secondary">On your Wishlist</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={wish.isPending}
                    className="pointer-coarse:min-h-11"
                    onClick={() => wish.mutate({ kind: 'ai', pick }, { onSuccess: () => setWished((w) => new Set(w).add(i)) })}
                  >
                    Add to Wishlist
                  </Button>
                )}
                {pick.url !== null ? (
                  <Button asChild size="sm" variant="ghost" className="pointer-coarse:min-h-11">
                    <a href={pick.url} target="_blank" rel="noopener noreferrer">
                      Open link
                    </a>
                  </Button>
                ) : null}
              </PickRow>
            ))}
          </ul>
        ) : null}
      </div>
    </PageSection>
  )
}
