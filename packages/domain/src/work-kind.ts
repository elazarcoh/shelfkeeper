import type { WorkKind } from './enums'
import { isLocked, type Provenance } from './provenance'

export const workKindLabel: Record<WorkKind, string> = { book: 'Book', fanfiction: 'Fanfiction', web_serial: 'Web serial' }

const TAG_KINDS: Record<string, WorkKind> = { fanfiction: 'fanfiction', fanfic: 'fanfiction', webserial: 'web_serial', webnovel: 'web_serial' }

const SITE_KINDS: { pattern: RegExp; kind: WorkKind }[] = [
  { pattern: /archiveofourown\.org|fanfiction\.net/i, kind: 'fanfiction' },
  { pattern: /royalroad\.com|scribblehub\.com/i, kind: 'web_serial' },
]

/** Fanfiction beats web serial within one rule. */
function preferFanfiction(found: Set<WorkKind>): WorkKind | null {
  return found.has('fanfiction') ? 'fanfiction' : found.has('web_serial') ? 'web_serial' : null
}

export function kindFromTags(tags: readonly string[]): WorkKind | null {
  const found = new Set<WorkKind>()
  for (const tag of tags) {
    const kind = TAG_KINDS[tag.toLowerCase().replace(/[\s_-]+/g, '')]
    if (kind) found.add(kind)
  }
  return preferFanfiction(found)
}

export function kindFromText(texts: readonly (string | null)[]): WorkKind | null {
  const found = new Set<WorkKind>()
  for (const text of texts) {
    if (!text) continue
    for (const { pattern, kind } of SITE_KINDS) if (pattern.test(text)) found.add(kind)
  }
  return preferFanfiction(found)
}

/** Ask AI pick, then tag, then site link; null or 'book' means no signal. */
export function inferKind(input: { aiKind?: WorkKind | null; tags: readonly string[]; texts: readonly (string | null)[] }): WorkKind | null {
  if (input.aiKind && input.aiKind !== 'book') return input.aiKind
  return kindFromTags(input.tags) ?? kindFromText(input.texts)
}

/** An automatic rule only moves an unlocked book: it never reverts a kind or replaces another automatic one. */
export function autoKindApplies(work: { kind: WorkKind; provenance: Provenance }): boolean {
  return work.kind === 'book' && !isLocked(work.provenance, 'kind')
}

/** The kind a merged work keeps; fromSource says the source's kind (and its provenance) won. */
export function mergeKind(
  target: { kind: WorkKind; provenance: Provenance },
  source: { kind: WorkKind; provenance: Provenance },
): { kind: WorkKind; fromSource: boolean } {
  const keepTarget = { kind: target.kind, fromSource: false }
  const takeSource = { kind: source.kind, fromSource: true }
  if (isLocked(target.provenance, 'kind')) return keepTarget
  if (isLocked(source.provenance, 'kind')) return takeSource
  return target.kind === 'book' && source.kind !== 'book' ? takeSource : keepTarget
}

/** Postgres `~*` regex sources for the Health check that suggests a kind for books that look like fanfiction or serials. */
export const KIND_SUGGESTION_SQL_PATTERNS = {
  fanfictionText: 'epub2tts|archiveofourown.org|fanfiction.net',
  fanfictionTitle: 'hogwarts|harry potter|hermione|\\mdraco\\M',
  serialText: 'royal ?road|web ?serial|web ?novel|scribble ?hub|spacebattles|originally published online',
}
