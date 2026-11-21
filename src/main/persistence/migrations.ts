// Upgrades a persisted document by exactly one format version. The runner stamps the new
// `version` on the result; the migration rewrites everything else, nested records included.
export type DocumentMigration = {
  fromVersion: number
  migrate(document: Record<string, unknown>): Record<string, unknown>
}

export type DocumentMigrations = {
  index?: readonly DocumentMigration[]
  canvas?: readonly DocumentMigration[]
}

// Format 2 is the first one ever persisted, so there is nothing to migrate from yet.
export const APP_INDEX_MIGRATIONS: readonly DocumentMigration[] = []
export const CANVAS_MIGRATIONS: readonly DocumentMigration[] = []

export function hasMigrationPath(
  migrations: readonly DocumentMigration[],
  fromVersion: number,
  toVersion: number
): boolean {
  for (let version = fromVersion; version < toVersion; version += 1) {
    if (!migrations.some((migration) => migration.fromVersion === version)) return false
  }
  return true
}

// Callers check `hasMigrationPath` first.
export function migrateDocument(
  document: Record<string, unknown>,
  migrations: readonly DocumentMigration[],
  toVersion: number
): Record<string, unknown> {
  let current = document
  for (let version = current.version as number; version < toVersion; version += 1) {
    const migration = migrations.find((candidate) => candidate.fromVersion === version)
    if (!migration) throw new Error(`No migration from format ${version}`)
    current = { ...migration.migrate(current), version: version + 1 }
  }
  return current
}
