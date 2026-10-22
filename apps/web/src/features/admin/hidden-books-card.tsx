import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { EyeOff } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SearchInput } from '@/components/ui/search-input'
import { Separator } from '@/components/ui/separator'
import { trpc } from '@/lib/trpc'
import { useDebounced } from '@/lib/use-debounced'

export function HiddenBooksCard({ userId, name }: { userId: string; name: string }) {
  const queryClient = useQueryClient()
  const [q, setQ] = useState('')
  const debounced = useDebounced(q, 250)
  const hidden = useQuery(trpc.admin.users.hidden.queryOptions({ userId }))
  const results = useQuery({ ...trpc.library.search.queryOptions({ q: debounced, limit: 8 }), enabled: debounced.trim().length >= 2 })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: trpc.admin.pathKey() })
  const hide = useMutation(trpc.admin.users.hideWork.mutationOptions({ onSuccess: refresh }))
  const unhide = useMutation(trpc.admin.users.unhideWork.mutationOptions({ onSuccess: refresh }))

  const hiddenIds = new Set(hidden.data?.works.map((w) => w.id))
  const candidates = debounced.trim().length >= 2 ? (results.data?.items ?? []).filter((i) => !hiddenIds.has(i.id)) : []

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Hidden books</CardTitle>
        <CardDescription>{name} will not see these anywhere — not in search, sets, lists or recommendations.</CardDescription>
      </CardHeader>
      {/* grid-cols-1 (minmax(0,1fr)) throughout: an auto track grows to a long title, so it could not truncate or wrap */}
      <CardContent className="grid grid-cols-1 gap-4">
        <SearchInput aria-label="Find a book to hide" placeholder="Find a book to hide…" value={q} onValueChange={setQ} />
        {candidates.length > 0 ? (
          <ul className="grid grid-cols-1 gap-2">
            {candidates.map((i) => (
              <li key={i.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate" dir="auto">
                  {i.title} <span className="text-muted-foreground">— {i.authors.join(', ')}</span>
                </span>
                <Button size="sm" variant="outline" aria-label={`Hide ${i.title}`} onClick={() => hide.mutate({ userId, workId: i.id })}>
                  <EyeOff className="size-4" /> Hide
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <Separator />
        {hidden.data && hidden.data.works.length > 0 ? (
          <ul className="grid grid-cols-1 gap-2">
            {hidden.data.works.map((w) => (
              <li key={w.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 break-words" dir="auto">
                  {w.title}
                </span>
                <Button size="sm" variant="ghost" aria-label={`Unhide ${w.title}`} onClick={() => unhide.mutate({ userId, workId: w.id })}>
                  Unhide
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing hidden.</p>
        )}
      </CardContent>
    </Card>
  )
}
