/**
 * `pnpm dev:seed-demo`: fills the local dev database with a fake household (packages/db/src/testing/demo-data.ts)
 * so every screen has something to show. Attaches the main history to the first admin (whose login is left
 * alone) and adds two members. Runs once per database; refuses anything but a local, non-production database.
 */
import { createDb, createSecretBox, DEV_SECRET_KEY } from '@mylib/db'
import { DemoAlreadySeededError, demoTargetRefusal, seedDemo } from '@mylib/db/demo'
import { hashSecret } from './auth/password'

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://mylib:mylib@localhost:5433/mylib'
const refusal = demoTargetRefusal(databaseUrl, process.env.NODE_ENV)
if (refusal !== null) {
  console.error(`Refusing to seed demo data: ${refusal}`)
  process.exit(2)
}
if (process.argv.includes('--reset-demo')) {
  console.error('--reset-demo is not supported: the demo data shares books, people and tags with anything you added yourself, so it cannot be removed exactly. Start from an empty database instead.')
  process.exit(2)
}

// the same key the dev server seals source credentials with (config.ts), so Admin → Sources can read them
const key = process.env.APP_SECRET_KEY === undefined || process.env.APP_SECRET_KEY === '' ? DEV_SECRET_KEY : process.env.APP_SECRET_KEY
const handle = createDb(databaseUrl, { max: 2 })
try {
  const summary = await seedDemo(handle.db, { hashSecret, secretBox: createSecretBox(key), log: (line) => console.log(`  ${line}`) })
  console.log(`
Demo data added (history attached to the admin "${summary.admin.username}", whose login is unchanged):
  ${summary.works} books (${summary.editions} editions), ${summary.sessions} reading sessions, ${summary.progressPoints} progress updates, ${summary.ratings} ratings,
  ${summary.loans} loans, ${summary.sets} sets, ${summary.goals} goals, ${summary.pendingInbox} pending Inbox items, ${summary.csvProposals} CSV rows to review.

Demo members (dev only):`)
  for (const m of summary.members) console.log(`  ${m.displayName.padEnd(6)} username ${m.username.padEnd(6)} password ${m.password}   PIN ${m.pin}`)
} catch (error) {
  if (error instanceof DemoAlreadySeededError) {
    console.error(error.message)
    process.exitCode = 1
  } else {
    throw error
  }
} finally {
  await handle.close()
}
