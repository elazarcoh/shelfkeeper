import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import type { BackupSettingsView } from '@mylib/domain'
import { Field } from '@/components/field'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { trpc } from '@/lib/trpc'
import { settingsInput, type SettingsFieldErrors } from './backup-view'

export function SettingsCard() {
  const settings = useQuery(trpc.backups.settings.queryOptions())
  if (!settings.data) return null
  // keyed: a fresh form whenever the saved settings change, instead of syncing state in render
  return <SettingsForm key={JSON.stringify(settings.data)} initial={settings.data} />
}

function SettingsForm({ initial }: { initial: BackupSettingsView }) {
  const queryClient = useQueryClient()
  const [schedule, setSchedule] = useState(initial.scheduleIsDefault ? '' : initial.schedule)
  const [keep, setKeep] = useState({
    scheduled: String(initial.retention.scheduled),
    preUpgrade: String(initial.retention.preUpgrade),
    preRestore: String(initial.retention.preRestore),
  })
  const save = useMutation(
    trpc.backups.updateSettings.mutationOptions({
      onSuccess: () => {
        toast.success('Backup settings saved')
        void queryClient.invalidateQueries({ queryKey: trpc.backups.pathKey() })
      },
    }),
  )
  const input = settingsInput(schedule, keep)
  const errors: SettingsFieldErrors = input.ok ? {} : input.errors
  const keepField = (key: keyof typeof keep, label: string) => (
    <Field label={label} htmlFor={`keep-${key}`} error={errors[key]}>
      <Input id={`keep-${key}`} type="number" min={1} value={keep[key]} onChange={(e) => setKeep({ ...keep, [key]: e.target.value })} />
    </Field>
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle>Schedule and retention</CardTitle>
        <CardDescription>Manual backups are never deleted automatically. The newest backup is never deleted.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          // items-start: a field with a hint is taller, and its row neighbour keeps its label level with this one (#9)
          className="grid items-start gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (input.ok) save.mutate(input.value)
          }}
        >
          <Field label="Schedule (cron, server time zone)" htmlFor="backup-schedule" hint={`Blank uses the default: ${initial.defaultSchedule}`} error={errors.schedule}>
            <Input id="backup-schedule" placeholder={initial.defaultSchedule} value={schedule} onChange={(e) => setSchedule(e.target.value)} />
          </Field>
          {keepField('scheduled', 'Keep scheduled backups')}
          {keepField('preUpgrade', 'Keep backups made before upgrades')}
          {keepField('preRestore', 'Keep backups made before restores')}
          <div className="sm:col-span-2">
            <Button type="submit" size="sm" disabled={!input.ok || save.isPending}>
              Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
