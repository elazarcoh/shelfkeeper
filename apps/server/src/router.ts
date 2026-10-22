import { adminRouter } from './routers/admin'
import { activityRouter } from './routers/activity'
import { authRouter } from './routers/auth'
import { backupsRouter } from './routers/backups'
import { catalogRouter } from './routers/catalog'
import { csvRouter } from './routers/csv'
import { goalsRouter } from './routers/goals'
import { hardcoverRouter } from './routers/hardcover'
import { inboxRouter } from './routers/inbox'
import { jobsRouter } from './routers/jobs'
import { libraryRouter } from './routers/library'
import { loansRouter } from './routers/loans'
import { progressRouter } from './routers/progress'
import { seriesRouter } from './routers/series'
import { shelfRouter } from './routers/shelf'
import { sessionsRouter } from './routers/sessions'
import { sourcesRouter } from './routers/sources'
import { statsRouter } from './routers/stats'
import { setsRouter } from './routers/sets'
import { systemRouter } from './routers/system'
import { trackingRouter } from './routers/tracking'
import { whatNextRouter } from './routers/what-next'
import { wishlistRouter } from './routers/wishlist'
import { router } from './trpc/init'

export const appRouter = router({
  activity: activityRouter,
  auth: authRouter,
  backups: backupsRouter,
  catalog: catalogRouter,
  csv: csvRouter,
  goals: goalsRouter,
  hardcover: hardcoverRouter,
  inbox: inboxRouter,
  jobs: jobsRouter,
  library: libraryRouter,
  loans: loansRouter,
  progress: progressRouter,
  series: seriesRouter,
  shelf: shelfRouter,
  sessions: sessionsRouter,
  sources: sourcesRouter,
  stats: statsRouter,
  sets: setsRouter,
  system: systemRouter,
  tracking: trackingRouter,
  whatNext: whatNextRouter,
  wishlist: wishlistRouter,
  admin: adminRouter,
})

export type AppRouter = typeof appRouter
