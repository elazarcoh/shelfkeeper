// Crash-test child: a covers job that downloads a cover every 400 ms, until the parent SIGKILLs it.
import { createHttpClient } from '@mylib/connectors'
import { createDb, createFileAssetStore, createSecretBox, DEV_SECRET_KEY } from '@mylib/db'
import { runCoversJob } from '../run-covers'
import { coverConnector } from './crash-sources'

const url = process.env.CRASH_DB_URL
const sourceId = process.env.CRASH_SOURCE_ID
const assetsDir = process.env.CRASH_ASSETS_DIR
if (url === undefined || sourceId === undefined || assetsDir === undefined) throw new Error('CRASH_DB_URL, CRASH_SOURCE_ID and CRASH_ASSETS_DIR are required')
const { db, close } = createDb(url)
await runCoversJob(
  { db, box: createSecretBox(DEV_SECRET_KEY), http: createHttpClient(), getConnector: () => coverConnector(400), store: createFileAssetStore(assetsDir) },
  { sourceId },
)
await close()
console.log('covers finished')
