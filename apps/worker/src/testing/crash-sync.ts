// Crash-test child: a sync that receives an item every 400 ms, until the parent SIGKILLs it.
import { createHttpClient } from '@mylib/connectors'
import { createDb, createSecretBox, DEV_SECRET_KEY } from '@mylib/db'
import { runSyncJob } from '../run-sync'
import { slowConnector } from './crash-sources'

const url = process.env.CRASH_DB_URL
const sourceId = process.env.CRASH_SOURCE_ID
if (url === undefined || sourceId === undefined) throw new Error('CRASH_DB_URL and CRASH_SOURCE_ID are required')
const { db, close } = createDb(url)
await runSyncJob(
  { db, box: createSecretBox(DEV_SECRET_KEY), http: createHttpClient(), getConnector: () => slowConnector(400), enqueueCovers: () => Promise.resolve() },
  { sourceId, runId: null },
)
await close()
console.log('sync finished')
