import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { trpc, type RouterOutputs } from '@/lib/trpc'
import { authorOf, useFollow } from './pick-list'

type Favorite = RouterOutputs['whatNext']['get']['favoriteAuthors'][number]

const keyOf = (a: { contributorId: string | null; hardcoverAuthorId: number | null; name: string }) => `${a.contributorId ?? ''}|${String(a.hardcoverAuthorId ?? '')}|${a.name}`

/** The authors the picks follow (read often, or followed by hand), with × to stop, and the stopped ones to bring back. */
export function YourAuthors({ favorites }: { favorites: Favorite[] }) {
  const follows = useQuery(trpc.whatNext.follows.queryOptions())
  const follow = useFollow()
  const hidden = follows.data?.filter((f) => f.mode === 'unfollow') ?? []
  return (
    <details className="rounded-lg border p-3 text-sm">
      <summary className="cursor-pointer font-medium">Your authors ({favorites.length})</summary>
      <div className="mt-3 grid gap-3">
        {favorites.length === 0 ? <p className="text-muted-foreground">Authors you read often show up here.</p> : null}
        <ul className="flex flex-wrap gap-2">
          {favorites.map((f) => {
            const author = authorOf(f)
            return (
              <li key={keyOf(f)} className="flex items-center gap-1 rounded-full border py-0.5 ps-3 pe-1">
                <span dir="auto">{f.name}</span>
                {f.why === 'auto' ? <span className="text-muted-foreground">(from your reads)</span> : null}
                {author !== null ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={follow.isPending}
                    aria-label={`Stop suggesting ${f.name}`}
                    className="size-7 rounded-full p-0 pointer-coarse:size-11"
                    onClick={() => follow.mutate({ author, mode: f.why === 'auto' ? 'unfollow' : null })}
                  >
                    <X className="size-4" />
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
        {hidden.length > 0 ? (
          <div>
            <p className="mb-1 text-muted-foreground">Hidden authors</p>
            <ul className="flex flex-wrap gap-2">
              {hidden.map((h) => {
                const author = authorOf(h)
                return (
                  <li key={keyOf(h)} className="flex items-center gap-1 rounded-full border py-0.5 ps-3 pe-1">
                    <span dir="auto">{h.name}</span>
                    {author !== null ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={follow.isPending}
                        aria-label={`Suggest ${h.name} again`}
                        className="h-7 px-2 pointer-coarse:min-h-11"
                        onClick={() => follow.mutate({ author, mode: null })}
                      >
                        Restore
                      </Button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  )
}
