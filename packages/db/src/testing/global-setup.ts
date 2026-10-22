import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { TestProject } from 'vitest/node'
import { runMigrations } from '../migrate'

let container: StartedPostgreSqlContainer | undefined

/** Starts one Postgres per test project and migrates it; that database is the template each test file clones. */
export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer('postgres:17').start()
  const url = container.getConnectionUri()
  await runMigrations(url)
  project.provide('databaseUrl', url)
  // the Postgres client tools run inside this container in tests (plan deviation 23)
  project.provide('pgContainerId', container.getId())
}

export async function teardown(): Promise<void> {
  await container?.stop()
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string
    pgContainerId: string
  }
}
