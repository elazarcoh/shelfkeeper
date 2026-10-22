type CopyEnv = { clipboard?: { writeText(t: string): Promise<void> }; secure: boolean; execCopy: () => boolean }
// execCommand is deprecated but is the only way to copy on a page that is not a secure context (plain http on the LAN)
/* eslint-disable-next-line @typescript-eslint/no-deprecated */
const browserEnv = (): CopyEnv => ({ clipboard: navigator.clipboard, secure: window.isSecureContext, execCopy: () => document.execCommand('copy') })

/** Clipboard API where allowed; on plain http, select the given textarea and execCommand('copy'). */
export async function copyText(text: string, fallback: HTMLTextAreaElement | null, env: CopyEnv = browserEnv()): Promise<boolean> {
  if (env.secure && env.clipboard) {
    try {
      await env.clipboard.writeText(text)
      return true
    } catch {
      // fall through to the textarea
    }
  }
  if (fallback === null) return false
  fallback.value = text
  fallback.focus()
  fallback.select()
  fallback.setSelectionRange(0, text.length)
  try {
    return env.execCopy()
  } catch {
    return false
  }
}
