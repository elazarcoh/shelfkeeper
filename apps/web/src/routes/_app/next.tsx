import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { toast } from 'sonner'
import { WHAT_NEXT, type WhatNextFormat, type WhatNextMood } from '@mylib/domain'
import { PageBody, PageHeader, PageSections } from '@/components/page'
import { Skeleton } from '@/components/ui/skeleton'
import { WorkCover } from '@/components/work-cover'
import { AskAiPanel } from '@/features/what-next/ask-ai-panel'
import { MoodChips } from '@/features/what-next/mood-chips'
import { PickList } from '@/features/what-next/pick-list'
import { lengthText } from '@/features/what-next/pick-row'
import { parseNextSearch } from '@/features/what-next/search'
import { YourAuthors } from '@/features/what-next/your-authors'
import { todayLocal } from '@/lib/format'
import { trpc, type RouterOutputs } from '@/lib/trpc'

export const Route = createFileRoute('/_app/next')({ validateSearch: parseNextSearch, component: NextPage })

type LastFinished = NonNullable<RouterOutputs['whatNext']['get']['lastFinished']>

/** Why the last book was heavy ("1,200 pages", "dark · tense"), or just its length when it was not. */
function finishedFact(b: LastFinished): string | null {
  const length = lengthText(b.pages, b.audioSec)
  if (!b.heavy) return length
  const longBook = (b.pages !== null && b.pages >= WHAT_NEXT.heavyPages) || (b.audioSec !== null && b.audioSec >= WHAT_NEXT.heavyAudioSec)
  if (longBook) return length
  const moods = b.moods.filter((m) => (WHAT_NEXT.heavyMoods as readonly string[]).includes(m))
  return moods.length > 0 ? moods.join(' · ') : length
}

function Finished({ book }: { book: LastFinished }) {
  const fact = finishedFact(book)
  return (
    <div className="flex items-center gap-3">
      <WorkCover title={book.title} coverAssetId={book.coverAssetId} label={false} className="w-10 shrink-0" />
      <div className="min-w-0">
        <p className="break-words" dir="auto">
          You just finished{' '}
          <Link to="/books/$workId" params={{ workId: book.workId }} className="font-medium hover:underline">
            <bdi>{book.title}</bdi>
          </Link>
        </p>
        {fact !== null ? <p className="text-sm text-muted-foreground">{fact}</p> : null}
      </div>
    </div>
  )
}

function NextPage() {
  const { user } = Route.useRouteContext()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const view = useQuery({
    ...trpc.whatNext.get.queryOptions({ mood: search.mood ?? null, format: search.format ?? null, today: todayLocal() }),
    placeholderData: keepPreviousData,
  })
  const setFormat = useMutation(trpc.whatNext.setFormat.mutationOptions({ onError: (e) => toast.error(e.message) }))
  const data = view.data
  const mood: WhatNextMood = search.mood ?? data?.preselected ?? 'surprise'
  const format: WhatNextFormat = search.format ?? data?.format ?? 'any'

  return (
    <PageBody width="narrow">
      <PageHeader title="What next?" />
      {view.isPending ? <Skeleton className="h-40 w-full" /> : null}
      {view.error ? (
        <p role="alert" className="text-sm text-destructive" dir="auto">
          Could not load your picks: {view.error.message} — reload the page to try again
        </p>
      ) : null}
      {data ? (
        <PageSections>
          <div className="grid gap-4">
            {data.lastFinished !== null ? <Finished book={data.lastFinished} /> : <p className="font-medium">Pick a mood</p>}
            <MoodChips
              mood={mood}
              format={format}
              onMood={(m) => void navigate({ search: (s) => ({ ...s, mood: m }), replace: true })}
              onFormat={(f) => {
                if (f === format) return
                void navigate({ search: (s) => ({ ...s, format: f }), replace: true })
                setFormat.mutate({ format: f })
              }}
            />
          </div>
          {!data.exploreEnabled ? (
            <p className="text-sm text-muted-foreground">
              {user.role === 'admin' ? (
                <Link to="/admin/hardcover" className="underline">
                  Connect Hardcover in Admin to explore beyond your shelves
                </Link>
              ) : (
                'Ask an admin to connect Hardcover to explore beyond your shelves'
              )}
            </p>
          ) : !data.personalLinked ? (
            <p className="text-sm text-muted-foreground">
              <Link to="/account" className="underline">
                Link your Hardcover account in My account for its recommendations
              </Link>
            </p>
          ) : null}
          {data.lists.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing to suggest from your shelves or Hardcover right now.{' '}
              <a href="#next-ask-ai" className="underline">
                Try Ask AI below
              </a>
            </p>
          ) : null}
          {data.lists.map((l) => (
            <PickList key={l.source} source={l.source} picks={l.picks} favorites={data.favoriteAuthors} />
          ))}
          <YourAuthors favorites={data.favoriteAuthors} />
          <AskAiPanel mood={mood} format={format} saved={data.aiAnswer?.text ?? null} />
        </PageSections>
      ) : null}
    </PageBody>
  )
}
