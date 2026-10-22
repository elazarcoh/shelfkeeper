import type { Context, MiddlewareHandler } from 'hono'
import type { MaintenanceControl, SecretBox } from '@mylib/db'
import type { MaintenanceState } from '@mylib/domain'
import type { JobQueue } from '@mylib/jobs'

/** Always answered, even in maintenance: Komodo's health check and the maintenance page's own polling. */
const OPEN_PATHS = new Set(['/health', '/maintenance', '/maintenance/status'])
/** Answered with JSON (the web client moves to /maintenance); every other path gets the HTML page. */
const API_PREFIXES = ['/trpc/', '/media/', '/admin/backups/upload', '/admin/backups/file/']

/** Fix round 1: a bare `'/trpc'` prefix would also match `/trpcx` — tighten to the exact path or a `/` boundary. */
function isApiPath(path: string): boolean {
  return path === '/trpc' || API_PREFIXES.some((prefix) => path.startsWith(prefix))
}

const MAINTENANCE_HEADERS = { 'x-mylib-maintenance': '1', 'retry-after': '10', 'cache-control': 'no-store' }

/**
 * Carried ruling R24: `state.message` (and `backupName`) may embed internal detail — a migration tag,
 * a describeError() string, an image path — that only a signed-in admin should see. Everyone else
 * (including every request before anyone is signed in) gets this generic line; `reason` stays visible
 * since it is one of a fixed, non-sensitive set of values the client can use for copy/an icon.
 */
// the page's heading already says "My Library is in maintenance"; this is the line under it
const GENERIC_MESSAGE = 'Please check back soon.'

export function publicState(state: MaintenanceState, isAdmin: boolean): MaintenanceState {
  if (isAdmin) return { reason: state.reason, message: state.message, since: state.since, backupName: state.backupName }
  return { reason: state.reason, message: GENERIC_MESSAGE, since: state.since, backupName: null }
}

/** eslint's `no-control-regex` refuses a literal control-character class, so this is a plain loop. */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

// Fix round 1 (Ruling R25): a percent-encoded control character (e.g. "%09" for a tab) doesn't
// trip hasControlChar, but some proxy or older browser could still decode it before routing — the
// same class of bug the raw-tab / backslash tricks below exploit. Reject it outright too.
const ENCODED_CONTROL_CHAR = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i

/**
 * Only a same-origin path on this site: never a scheme-relative URL (`//evil.example`), an absolute
 * URL (`https://evil.example`), or a backslash trick a browser's URL parser treats as one of those
 * (`/\evil.example`) — this is an open-redirect guard (Ruling R25, fix round 1). Resolving against a
 * fixed dummy origin and comparing `origin` catches all of those uniformly, since a same-site path
 * can never change the origin; a control character (raw or percent-encoded) is refused outright.
 */
export function safeNext(next: string | undefined, fallback = '/'): string {
  if (next === undefined || hasControlChar(next) || ENCODED_CONTROL_CHAR.test(next)) return fallback
  try {
    const url = new URL(next, 'http://mylib.invalid')
    if (url.origin !== 'http://mylib.invalid') return fallback
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return fallback
  }
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)

/** "2026-10-06 16:05 UTC" from an ISO timestamp: shown until the page's script swaps in local time. */
export function readableUtc(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/**
 * Self-contained (no bundle, no API): it must work while everything else is refused. Callers pass the
 * state through `publicState` first — this renders whatever it's given, admin detail or the generic line.
 * `basePath` is the URL prefix the app is served under ('' at the root).
 */
export function maintenancePage(state: MaintenanceState, basePath = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>My Library — maintenance</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem;line-height:1.5;color:#222}h1{font-size:1.4rem}.muted{color:#666;font-size:.9rem}@media (prefers-color-scheme:dark){body{background:#18181b;color:#eee}.muted{color:#aaa}}</style>
</head><body>
<h1>My Library is in maintenance</h1>
<p dir="auto">${escapeHtml(state.message)}</p>
<p class="muted">Since <time id="since" datetime="${escapeHtml(state.since)}">${escapeHtml(readableUtc(state.since))}</time>. This page checks again every few seconds.</p>
<script>
(function(){
  var t=document.getElementById('since');var d=new Date(t.getAttribute('datetime'));
  if(!isNaN(d.getTime()))t.textContent=d.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
})();
(function(){
  function isCtrl(code){return code<=31||code===127}
  function hasCtrl(s){for(var i=0;i<s.length;i++){if(isCtrl(s.charCodeAt(i)))return true}return false}
  function hasEncodedCtrl(s){var l=s.toLowerCase();for(var i=0;i<l.length-2;i++){if(l.charAt(i)==='%'){var n=parseInt(l.slice(i+1,i+3),16);if(!isNaN(n)&&isCtrl(n))return true}}return false}
  function safeNext(p){
    if(p===null||hasCtrl(p)||hasEncodedCtrl(p))return null;
    try{
      var u=new URL(p,location.origin);
      if(u.origin!==location.origin)return null;
      return u.pathname+u.search+u.hash;
    }catch(e){return null}
  }
  var p=new URLSearchParams(location.search).get('next');
  var next=safeNext(p);
  if(next===null)next=(location.pathname==='${basePath}/maintenance'?'${basePath}/':location.pathname+location.search);
  setInterval(function(){fetch('${basePath}/maintenance/status',{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){if(s.maintenance===null)location.replace(next)}).catch(function(){})},3000);
})();
</script>
</body></html>`
}

/**
 * Resolves whether the current request belongs to a signed-in admin (Ruling R24). Failing (e.g. the
 * database is itself the problem) is treated as "not admin" — safe by default; a real admin's own
 * session is re-checked on every page load and every `/maintenance/status` poll.
 */
export type AdminResolver = (req: Request) => Promise<boolean>
const alwaysNonAdmin: AdminResolver = () => Promise.resolve(false)

/** Plan deviation 2: this process's side of maintenance. */
export class MaintenanceGate {
  private current: MaintenanceState | null = null
  private inFlight = 0

  get state(): MaintenanceState | null {
    return this.current
  }

  /** Start-up: maintenance until the process restarts (or `leave`). */
  hold(state: MaintenanceState): void {
    this.current = state
  }

  /** Refuses new requests at once, then waits (at most `drainMs`) for those already running. */
  async enter(state: MaintenanceState, drainMs = 30_000): Promise<void> {
    this.current = state
    const deadline = Date.now() + drainMs
    while (this.inFlight > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  }

  leave(): void {
    this.current = null
  }

  control(): MaintenanceControl {
    return { enter: (state) => this.enter(state), leave: () => this.leave() }
  }

  /**
   * `resolveAdmin` decides who sees the raw message/backupName vs. the generic line (Ruling R24).
   * Callers with no session concept (a smoke test, or a caller that just wants the drain behaviour)
   * can omit it — everyone then gets the generic line, which is the safe default.
   */
  middleware(resolveAdmin: AdminResolver = alwaysNonAdmin, basePath = ''): MiddlewareHandler {
    return async (c: Context, next) => {
      if (OPEN_PATHS.has(c.req.path)) {
        await next()
        return
      }
      const state = this.current
      if (state !== null) {
        const isAdmin = await resolveAdmin(c.req.raw).catch(() => false)
        const visible = publicState(state, isAdmin)
        if (isApiPath(c.req.path)) return c.json({ maintenance: visible }, 503, MAINTENANCE_HEADERS)
        return c.html(maintenancePage(visible, basePath), 503, MAINTENANCE_HEADERS)
      }
      this.inFlight++
      try {
        await next()
      } finally {
        this.inFlight--
      }
    }
  }
}

const unavailable = (): Promise<never> => Promise.reject(new Error('My Library is in maintenance'))

/** Stand-ins while the app starts in maintenance: the gate refuses every request that could reach them. */
export const unavailableJobs: JobQueue = { enqueueSync: unavailable, enqueueCovers: unavailable, enqueueBackup: unavailable, enqueueHardcover: unavailable, enqueueAbsPush: unavailable }

export const lockedSecrets: SecretBox = {
  seal: () => {
    throw new Error('APP_SECRET_KEY is not usable')
  },
  open: () => {
    throw new Error('APP_SECRET_KEY is not usable')
  },
}
