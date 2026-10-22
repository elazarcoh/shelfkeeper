import { getConstructionPlans } from 'pg-boss'
import { describe, expect, inject, it } from 'vitest'
import { startBoss } from './index'

/**
 * pg-boss migrates its own `pgboss` schema when it starts — outside our migrations, so outside the
 * pre-upgrade backup and the "refuse a newer database" check. Bumping pg-boss to a version whose schema
 * differs from this pin needs a decision first (take the pre-upgrade backup before pg-boss starts, or
 * refuse a newer pgboss schema) — only then change the pin. docs/install.md → Upgrade says how to roll back.
 */
const PINNED_PGBOSS_SCHEMA_VERSION = 43

describe('pg-boss schema version (final fix 4)', () => {
  it('is the pinned one in the installed pg-boss', () => {
    expect(getConstructionPlans('pgboss')).toContain(`INSERT INTO pgboss.version(version) VALUES ('${PINNED_PGBOSS_SCHEMA_VERSION}')`)
  })

  it('is the pinned one in a database pg-boss has started on', async () => {
    const boss = await startBoss(inject('databaseUrl'), 'sender')
    try {
      expect(await boss.schemaVersion()).toBe(PINNED_PGBOSS_SCHEMA_VERSION)
    } finally {
      await boss.stop()
    }
  })
})
