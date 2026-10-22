import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { withBase } from '@/lib/base-path'
import { backupKindLabel, parseUploadResponse, type UploadedBackup } from './backup-view'
import { RestoreDialog } from './restore-dialog'

type UploadState = { kind: 'idle' } | { kind: 'uploading' } | { kind: 'error'; message: string } | { kind: 'ready'; upload: UploadedBackup }

export function UploadCard() {
  const [state, setState] = useState<UploadState>({ kind: 'idle' })

  async function upload(file: File): Promise<void> {
    setState({ kind: 'uploading' })
    try {
      const res = await fetch(withBase('/admin/backups/upload'), { method: 'POST', headers: { 'content-type': 'application/zip' }, body: file })
      const body: unknown = await res.json().catch(() => null)
      const parsed = parseUploadResponse(res.status, body)
      setState(parsed.ok ? { kind: 'ready', upload: parsed.upload } : { kind: 'error', message: parsed.message })
    } catch {
      setState({ kind: 'error', message: 'The upload failed' })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Restore from a file</CardTitle>
        <CardDescription>Upload a backup .zip (for example one you downloaded, or one from another install).</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Input
          type="file"
          accept=".zip,application/zip"
          aria-label="Backup file"
          disabled={state.kind === 'uploading'}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void upload(file)
          }}
        />
        {state.kind === 'uploading' ? <p className="text-sm text-muted-foreground">Uploading and checking the backup…</p> : null}
        {state.kind === 'error' ? (
          <p className="text-sm text-destructive" dir="auto">
            {state.message}
          </p>
        ) : null}
        {state.kind === 'ready' ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>
              {backupKindLabel[state.upload.kind]} backup from {new Date(state.upload.createdAt).toLocaleString()}, version {state.upload.appVersion}.
            </span>
            <RestoreDialog
              source={{ kind: 'upload', uploadId: state.upload.uploadId }}
              label={`the uploaded backup from ${new Date(state.upload.createdAt).toLocaleString()}`}
              trigger={<Button size="sm">Restore this backup</Button>}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
