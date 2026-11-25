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

// Format 2 is the first one ever persisted. Every record carries the format version, so each step
// restamps the nested records it rewrites.
export const APP_INDEX_MIGRATIONS: readonly DocumentMigration[] = [
  // Format 3 changed only canvases; the index's records only take the new version.
  { fromVersion: 2, migrate: (document) => ({ ...document, projects: restamp(document.projects, 3) }) }
]

export const CANVAS_MIGRATIONS: readonly DocumentMigration[] = [
  {
    // Format 3: reconciliation no longer adds delegated agent nodes, so the list of resources it must not
    // add back is gone. Activity actors are unchanged: a null agent node is new in format 3.
    fromVersion: 2,
    migrate: (document) => {
      const migrated: Record<string, unknown> = {
        ...document,
        nodes: restamp(document.nodes, 3),
        edges: restamp(document.edges, 3),
        workspaces: restamp(document.workspaces, 3)
      }
      delete migrated.dismissedResources
      return migrated
    }
  }
]

// Leaves a value that is not a list of records for validation to reject.
function restamp(records: unknown, version: number): unknown {
  if (!Array.isArray(records)) return records
  return records.map((record: unknown) =>
    typeof record === 'object' && record !== null && !Array.isArray(record) ? { ...record, version } : record
  )
}

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
