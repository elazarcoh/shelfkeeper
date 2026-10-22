import { applyMigrations, defaultMigrationsFolder } from './ops/migrations'

/** Applies every pending migration (each in its own transaction). The app's start-up uses prepareDatabase instead. */
export async function runMigrations(url: string, migrationsFolder: string = defaultMigrationsFolder): Promise<void> {
  await applyMigrations(url, migrationsFolder)
}
