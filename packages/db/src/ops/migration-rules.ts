/**
 * Spec §5 migration rules. Migrations are drizzle-kit-generated and additive only:
 * - DROP, RENAME and type-narrowing statements fail unless allow-listed here with their two-release plan
 *   (release N stops using the thing; release N+1 removes it).
 * - Plain (non-concurrent) index builds are accepted at household scale: they lock the table for
 *   seconds. CONCURRENTLY cannot run inside the per-migration transaction.
 *
 * Not a rule enforced here (nothing here can see whether a later statement reads the new value), but
 * worth remembering when writing a migration: `ALTER TYPE ... ADD VALUE` cannot be used in the same
 * transaction that added it — PostgreSQL forbids reading a brand new enum label before that transaction
 * commits — so a migration that adds an enum value and then uses it (e.g. as a column default, or in a
 * CHECK) fails inside our per-migration transaction. Split it across two migrations instead.
 */
export interface AllowedStatement {
  tag: string
  statement: RegExp
  plan: string
}

export const MIGRATION_ALLOW_LIST: readonly AllowedStatement[] = [
  {
    tag: '0003_sources_proposals_jobs',
    statement: /^ALTER TABLE "loan" DROP CONSTRAINT "loan_borrower_user_id_app_user_id_fk";$/,
    plan: 'Before the first release (3a): the same migration re-creates this foreign key with ON DELETE restrict. No data is dropped, and no released schema had the old constraint.',
  },
  {
    tag: '0015_progress_edition_day',
    statement: /^DROP INDEX "reading_progress_session_day_idx";$/,
    plan: 'One release, no two-release path (#68): the same migration adds the wider UNIQUE (session_id, edition_id, occurred_on), which every existing row already satisfies, so no data is dropped. The old key had to go for two volumes to keep a point on one day. Rolling back to v0.4.29 or earlier would break saving progress (its ON CONFLICT targets the old key): restore the pre-upgrade backup instead.',
  },
  {
    tag: '0021_work_language_drop',
    statement: /^ALTER TABLE "work" DROP COLUMN "language";$/,
    plan: 'Two releases (#124, docs/superpowers/specs/2026-10-19-edition-only-language-design.md): v0.4.58 stopped reading and writing work.language and its 0020 copied each book\'s language onto its editions that had none; this release drops the column. A book with no editions loses its language, as ruled. Rolling back past this release means restoring the pre-upgrade backup.',
  },
]

const RULES: readonly { name: string; pattern: RegExp }[] = [
  { name: 'DROP', pattern: /\bDROP\b/i },
  { name: 'RENAME', pattern: /\bRENAME\b/i },
  { name: 'column type change', pattern: /\bALTER\s+COLUMN\s+"[^"]+"\s+(?:SET\s+DATA\s+)?TYPE\b/i },
  { name: 'SET NOT NULL', pattern: /\bSET\s+NOT\s+NULL\b/i },
  { name: 'TRUNCATE or DELETE', pattern: /\b(?:TRUNCATE|DELETE\s+FROM)\b/i },
  { name: 'CREATE INDEX CONCURRENTLY (cannot run inside the per-migration transaction)', pattern: /\bCONCURRENTLY\b/i },
]

export function splitStatements(sqlText: string): string[] {
  return sqlText
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

export interface Violation {
  tag: string
  rule: string
  statement: string
}

export function migrationViolations(tag: string, sqlText: string, allowList: readonly AllowedStatement[] = MIGRATION_ALLOW_LIST): Violation[] {
  const violations: Violation[] = []
  for (const statement of splitStatements(sqlText)) {
    const allowed = allowList.some((a) => a.tag === tag && a.statement.test(statement))
    for (const rule of RULES) {
      if (!allowed && rule.pattern.test(statement)) violations.push({ tag, rule: rule.name, statement })
    }
  }
  return violations
}
