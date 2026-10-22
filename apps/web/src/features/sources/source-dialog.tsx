import { useState, type ReactNode, type SubmitEvent } from 'react'
import { toast } from 'sonner'
import { sourceSchedules, syncedSourceKinds } from '@mylib/domain'
import { Field } from '@/components/field'
import { NativeSelect } from '@/components/native-select'
import { sourceKindLabel } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { secretLabel, type SourceForm } from './source-form-state'

const scheduleLabel = { hourly: 'Every hour', daily: 'Every day (3:00 UTC)', weekly: 'Every week (Sunday 3:00 UTC)' } as const

interface Props {
  title: string
  trigger: ReactNode
  initial: SourceForm
  /** editing an existing source: the token field may stay blank */
  editing?: boolean
  /** return an error message to keep the dialog open, or null when saved */
  onSave: (form: SourceForm) => Promise<string | null>
}

export function SourceDialog({ title, trigger, initial, editing = false, onSave }: Props) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<SourceForm>(initial)
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof SourceForm>(key: K, value: SourceForm[K]) => setForm((f) => ({ ...f, [key]: value }))

  async function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    try {
      const problem = await onSave(form)
      if (problem === null) setOpen(false)
      else toast.error(problem)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setForm(initial)
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle dir="auto" className="text-match-parent">
            {title}
          </DialogTitle>
          <DialogDescription>{sourceKindLabel[form.kind]} server. My Library only ever reads from it.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <Field label="Name" htmlFor="source-name">
            <Input id="source-name" dir="auto" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          {!editing ? (
            <Field label="Kind" htmlFor="source-kind">
              <NativeSelect
                id="source-kind"
                value={form.kind}
                onChange={(e) => {
                  const kind = syncedSourceKinds.find((k) => k === e.target.value)
                  if (kind) setForm((f) => ({ ...f, kind, secret: '' }))
                }}
              >
                {syncedSourceKinds.map((k) => (
                  <option key={k} value={k}>
                    {sourceKindLabel[k]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
          <Field label="Server URL" htmlFor="source-url" hint="e.g. http://192.168.1.10:13378">
            <Input id="source-url" inputMode="url" value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} />
          </Field>
          {form.kind === 'calibre' ? (
            <Field label="Username (optional)" htmlFor="source-username" hint="Only if the content server requires a login (it must use --auth-mode=basic)">
              <Input id="source-username" autoComplete="off" value={form.username} onChange={(e) => set('username', e.target.value)} />
            </Field>
          ) : null}
          {form.kind !== 'calibre' || form.username.trim() !== '' ? (
            <Field
              label={secretLabel[form.kind]}
              htmlFor="source-secret"
              hint={
                editing
                  ? `Leave blank to keep the current ${secretLabel[form.kind].toLowerCase()}`
                  : form.kind === 'audiobookshelf'
                    ? 'Audiobookshelf → Settings → Users → your user → API token'
                    : form.kind === 'calibre'
                      ? undefined
                      : 'Settings → General → Security → API Key'
              }
            >
              <Input id="source-secret" type="password" autoComplete="off" value={form.secret} onChange={(e) => set('secret', e.target.value)} />
            </Field>
          ) : null}
          {form.kind === 'audiobookshelf' ? (
            <Field label="Library IDs (optional)" htmlFor="source-libraries" hint="Comma-separated. Blank = every book library.">
              <Input id="source-libraries" value={form.libraryIds} onChange={(e) => set('libraryIds', e.target.value)} />
            </Field>
          ) : null}
          {form.kind === 'calibre' ? (
            <>
              <Field label="Library (optional)" htmlFor="source-library" hint="Blank = the server's default library">
                <Input id="source-library" dir="auto" value={form.libraryId} onChange={(e) => set('libraryId', e.target.value)} />
              </Field>
              <Field label="Word count column (optional)" htmlFor="source-words" hint="A custom column's lookup name, e.g. #words">
                <Input id="source-words" value={form.wordCountColumn} onChange={(e) => set('wordCountColumn', e.target.value)} />
              </Field>
            </>
          ) : null}
          <Field label="Schedule" htmlFor="source-schedule">
            <NativeSelect
              id="source-schedule"
              value={form.schedule}
              onChange={(e) => set('schedule', sourceSchedules.find((s) => s === e.target.value) ?? '')}
            >
              <option value="">Only when I press “Sync now”</option>
              {sourceSchedules.map((s) => (
                <option key={s} value={s}>
                  {scheduleLabel[s]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={saving}>
              Save source
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
