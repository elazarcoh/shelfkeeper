// Crash-test child: applies the migrations in CRASH_MIGRATIONS (one of them sleeps), until the parent SIGKILLs it.
import { applyMigrations } from '../../ops/migrations'

const url = process.env.CRASH_DB_URL
const folder = process.env.CRASH_MIGRATIONS
if (url === undefined || folder === undefined) throw new Error('CRASH_DB_URL and CRASH_MIGRATIONS are required')
await applyMigrations(url, folder)
console.log('migrations finished')
