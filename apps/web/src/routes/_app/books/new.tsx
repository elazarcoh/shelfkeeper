import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo, useState, type SubmitEvent } from 'react'
import { toast } from 'sonner'
import { CreateWorkInput, EditionInput } from '@mylib/domain'
import { showFieldErrors } from '@/components/field'
import { PageBody, PageHeader } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { CatalogMatches } from '@/features/book/catalog-matches'
import { EditionFields } from '@/features/book/edition-form'
import { editionFormToInput, emptyEditionForm } from '@/features/book/edition-form-state'
import { useInvalidateBook } from '@/features/book/invalidate'
import { WorkFields } from '@/features/book/work-form'
import { emptyWorkForm, workFormToInput } from '@/features/book/work-form-state'
import { fieldErrors, parseLines, scopedErrors, type FieldErrors } from '@/lib/form'
import { trpc } from '@/lib/trpc'
import { useDebounced } from '@/lib/use-debounced'

export const Route = createFileRoute('/_app/books/new')({ component: NewBookPage })

function NewBookPage() {
  const navigate = useNavigate()
  const invalidate = useInvalidateBook()
  const [work, setWork] = useState(emptyWorkForm)
  const [edition, setEdition] = useState(() => emptyEditionForm('physical'))
  const [addToMyBooks, setAddToMyBooks] = useState(true)
  const [errors, setErrors] = useState<FieldErrors>({})

  const probe = useDebounced([work.title, parseLines(work.authors)[0] ?? ''].join(' ').trim(), 300)
  // keepPreviousData: matches stay put while the next search runs, so the fields below do not flicker
  const matches = useQuery({ ...trpc.library.search.queryOptions({ q: probe, limit: 5 }), enabled: probe.length >= 3, placeholderData: keepPreviousData })

  const goTo = (workId: string) => void navigate({ to: '/books/$workId', params: { workId } })
  const create = useMutation(
    trpc.catalog.create.mutationOptions({
      onSuccess: ({ workId }) => {
        invalidate()
        toast.success('Book added')
        goTo(workId)
      },
    }),
  )
  const addEdition = useMutation(
    trpc.catalog.addEdition.mutationOptions({
      onSuccess: (_result, vars) => {
        invalidate()
        toast.success('Added as a new edition')
        goTo(vars.workId)
      },
    }),
  )

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    // a book is left unset so the automatic kind rules can still apply (#133)
    const { kind, ...fields } = workFormToInput(work)
    const parsed = CreateWorkInput.safeParse({ ...fields, ...(kind === 'book' ? {} : { kind }), editions: [editionFormToInput(edition)] })
    if (!parsed.success) {
      // focus the first invalid field: on a phone the message is otherwise easily off screen (a field in a closed
      // "More details" cannot take focus; MoreDetails opens and focuses it instead)
      showFieldErrors(e.currentTarget, fieldErrors(parsed.error), setErrors)
      return
    }
    setErrors({})
    create.mutate({ work: parsed.data, addToMyBooks })
  }

  function addAsEdition(workId: string) {
    const parsed = EditionInput.safeParse(editionFormToInput(edition))
    if (!parsed.success) {
      const scoped = fieldErrors(parsed.error)
      setErrors(Object.fromEntries(Object.entries(scoped).map(([k, v]) => [`editions.0.${k}`, v])))
      return
    }
    addEdition.mutate({ workId, edition: parsed.data, addToMyBooks })
  }

  // memoised so the edition's "More details" only reopens on a fresh submit, not on every keystroke
  const editionErrors = useMemo(() => scopedErrors(errors, 'editions.0.'), [errors])
  const candidates = probe.length >= 3 ? (matches.data?.items ?? []) : []

  return (
    <PageBody width="narrow">
      <PageHeader
        title="Add a book"
        description="Physical books, borrowed books, or anything no source knows about."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/books/import">Import a CSV file</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/books/shelf">From a shelf photo</Link>
            </Button>
          </div>
        }
      />
      {/* pb: with the on-screen keyboard up, the page can still scroll the last field above the sticky bar */}
      <form onSubmit={submit} className="grid grid-cols-1 gap-6 pb-[var(--keyboard-inset,0px)] lg:pb-0">
        <Card>
          <CardHeader>
            <CardTitle>Book</CardTitle>
          </CardHeader>
          <CardContent>
            <WorkFields
              idPrefix="new-work"
              value={work}
              onChange={setWork}
              errors={errors}
              collapseOptional
              afterTitle={<CatalogMatches candidates={candidates} busy={addEdition.isPending} loading={probe.length >= 3 && matches.isFetching} onAddAsEdition={addAsEdition} />}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Edition</CardTitle>
            <CardDescription>The copy you have or had — yours, or borrowed.</CardDescription>
          </CardHeader>
          <CardContent>
            <EditionFields
              idPrefix="new-edition"
              value={edition}
              onChange={setEdition}
              errors={editionErrors}
              showHolding
              collapseOptional
            />
          </CardContent>
        </Card>
        {/* Sticky above the bottom tabs (and above the on-screen keyboard); index.css pads scrolling so it never covers a focused field.
            Edge to edge below lg: --bleed is the page padding plus, from md, the gap either side of the centred 42rem (max-w-2xl)
            column, measured against PageBody's width (100cqw). */}
        <div
          data-sticky-submit
          className="sticky bottom-[max(var(--bottom-offset),var(--keyboard-inset,0px))] z-page-sticky -mx-4 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur md:[--bleed:max(1.5rem,calc((100cqw_-_42rem)/2_+_1.5rem))] md:-mx-(--bleed) md:px-(--bleed) lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:px-0 lg:py-0 lg:backdrop-blur-none"
        >
          <div className="flex min-h-11 items-center gap-2">
            <Checkbox id="add-to-my-books" checked={addToMyBooks} onCheckedChange={(v) => setAddToMyBooks(v === true)} />
            <Label htmlFor="add-to-my-books">Add to My books</Label>
          </div>
          <Button type="submit" disabled={create.isPending}>
            Add book
          </Button>
        </div>
      </form>
    </PageBody>
  )
}
