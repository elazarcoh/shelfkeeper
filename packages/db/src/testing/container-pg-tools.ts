import { createPgTools, type PgTools, type PgToolsOptions } from '../ops/pg-tools'

/** pg_dump/pg_restore inside a Postgres container (plan deviation 23). */
export function containerPgTools(containerId: string, options: Pick<PgToolsOptions, 'timeoutsMs' | 'killGraceMs'> = {}): PgTools {
  return createPgTools({
    ...options,
    prefix: ['docker', 'exec', '-i', '-e', 'PGPASSWORD', containerId],
    rewriteUrl: (url) => {
      const u = new URL(url)
      u.hostname = 'localhost'
      u.port = '5432'
      return u.toString()
    },
  })
}
