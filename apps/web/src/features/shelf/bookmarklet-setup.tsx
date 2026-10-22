import { useRef } from 'react'
import { toast } from 'sonner'
import { bookmarkletUrl } from '@mylib/domain'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { withBase } from '@/lib/base-path'
import { copyText } from '@/lib/copy-text'

/** One-time setup of the bookmarklet that sends a Simania book page back to this page. */
export function BookmarkletSetup() {
  const area = useRef<HTMLTextAreaElement>(null)
  const details = useRef<HTMLDetailsElement>(null)
  // this app only runs in the browser, and the value has no side effects
  const code = bookmarkletUrl(new URL(withBase('/books/shelf'), window.location.origin).toString())
  async function copy() {
    // the textarea is the plain-http fallback: it is inside this <details>, which stays open while the click runs
    if (!window.isSecureContext && details.current) details.current.open = true
    if (await copyText(code, area.current)) toast.success('Code copied')
    else toast.error('Select the code and copy it')
  }
  return (
    <details ref={details} className="rounded-lg border p-4">
      <summary className="cursor-pointer text-sm font-medium">Optional: skip the copy-paste with the mylib bookmarklet</summary>
      <div className="mt-3 grid gap-3 text-sm">
        <p className="text-muted-foreground">Pasting a Simania link always works. With the bookmarklet, one tap on the book's page sends it here instead.</p>
        <ol className="grid list-decimal gap-1 ps-5">
          <li>Tap Copy code below.</li>
          <li>Bookmark this page in your browser.</li>
          <li>Edit the bookmark: name it mylib and paste the code as its address (URL).</li>
          <li>On a Simania book page, type mylib in the address bar and tap the ☆ suggestion.</li>
        </ol>
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
            Copy code
          </Button>
        </div>
        <Textarea ref={area} readOnly dir="ltr" aria-label="Bookmarklet code" value={code} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
      </div>
    </details>
  )
}
