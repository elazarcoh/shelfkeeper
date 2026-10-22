// Crash-test child: a CSV import that pauses (still inside its one transaction) after
// CRASH_STOP_AFTER_ROW rows, until the parent SIGKILLs it — a deterministic mid-transaction kill,
// not a race against how much of the 2000 rows a fast machine gets through first.
import { createDb } from '../../client'
import { sleep } from '../../ops/fs-utils'
import { importCsv } from '../../repos/csv-import'
import { loadUserScope } from '../../repos/scope'
import { CRASH_PAUSED_MARKER, CRASH_STOP_AFTER_ROW, crashCsvInput } from '../crash-inputs'

const url = process.env.CRASH_DB_URL
const userId = process.env.CRASH_USER_ID
if (url === undefined || userId === undefined) throw new Error('CRASH_DB_URL and CRASH_USER_ID are required')
const { db, close } = createDb(url)
await importCsv(db, await loadUserScope(db, { id: userId, role: 'member' }), crashCsvInput(), {
  hooks: {
    afterRow: async (rowsWritten) => {
      if (rowsWritten === CRASH_STOP_AFTER_ROW) {
        console.log(CRASH_PAUSED_MARKER)
        await sleep(120_000)
      }
    },
  },
})
await close()
console.log('import finished')
