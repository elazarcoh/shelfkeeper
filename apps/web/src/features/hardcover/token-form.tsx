import { useState, type SubmitEvent } from 'react'
import { Field } from '@/components/field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** A write-only token field: the saved token is never shown; Save tests it with Hardcover first. */
export function TokenForm({ id, saving, error, onSave }: { id: string; saving: boolean; error: string | undefined; onSave: (token: string) => Promise<unknown> }) {
  const [token, setToken] = useState('')
  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    if (token.trim() !== '') void onSave(token).then(() => setToken(''), () => undefined)
  }
  return (
    <form onSubmit={submit} className="grid gap-2">
      <Field label="Hardcover API token" htmlFor={id} error={error} hint="From hardcover.app → Settings → Hardcover API. It is kept encrypted and never shown again.">
        <Input id={id} type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} />
      </Field>
      <a className="text-sm underline" href="https://hardcover.app/account/api" target="_blank" rel="noreferrer noopener">
        Get a token on Hardcover ↗
      </a>
      <div>
        <Button type="submit" disabled={saving || token.trim() === ''}>
          {saving ? 'Checking…' : 'Save token'}
        </Button>
      </div>
    </form>
  )
}
