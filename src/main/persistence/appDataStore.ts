import { join, resolve } from 'node:path'
import { DOMAIN_RECORD_VERSION, createEmptyCanvas, type Canvas } from '../../shared/domain'
import { RecordValidationError, parseCanvas } from '../../shared/recordValidation'
import { createDefaultAppIndex, mergeSettingsOverDefaults, parseAppIndex, type AppIndex } from './appIndex'
import { CorruptDataError, InvalidRecordError, UnsupportedVersionError } from './errors'
import {
  SerialQueue,
  isFileNotFound,
  nodeFileOperations,
  writeFileAtomically,
  type PersistenceFileOperations
} from './fileOperations'
import {
  APP_INDEX_MIGRATIONS,
  CANVAS_MIGRATIONS,
  hasMigrationPath,
  migrateDocument,
  type DocumentMigration,
  type DocumentMigrations
} from './migrations'
import { assertSafeId } from './safeId'

export type AppDataStoreOptions = {
  // SPADE's own application-data directory. The store never touches anything outside it.
  directory: string
  files?: PersistenceFileOperations
  now?: () => Date
  migrations?: DocumentMigrations
}

type DocumentSpec<Value> = {
  path: string
  // Stem of this document's backup file names.
  backupStem: string
  migrations: readonly DocumentMigration[]
  // Throws RecordValidationError.
  parse(document: Record<string, unknown>): Value
}

// Layout:
//   index.json                 AppIndex
//   canvases/<projectId>.json  one Canvas per project
//   backups/                   originals kept before a migration, and corrupt files moved aside
export class AppDataStore {
  readonly directory: string
  private readonly files: PersistenceFileOperations
  private readonly now: () => Date
  private readonly migrations: Required<DocumentMigrations>
  private readonly queue = new SerialQueue()
  // Files this store has read or written in the current format, so a save may replace them.
  private readonly writable = new Set<string>()
  // Files in a format this store must never overwrite.
  private readonly refused = new Map<string, UnsupportedVersionError>()

  constructor(options: AppDataStoreOptions) {
    this.directory = resolve(options.directory)
    this.files = options.files ?? nodeFileOperations
    this.now = options.now ?? (() => new Date())
    this.migrations = {
      index: options.migrations?.index ?? APP_INDEX_MIGRATIONS,
      canvas: options.migrations?.canvas ?? CANVAS_MIGRATIONS
    }
  }

  // Missing file: the default index. Rejects with CorruptDataError or UnsupportedVersionError.
  async loadIndex(): Promise<AppIndex> {
    const loaded = await this.load(this.indexSpec())
    return loaded ?? createDefaultAppIndex()
  }

  async saveIndex(index: AppIndex): Promise<void> {
    const serialized = serialize('app index', index, parseAppIndex)
    await this.save(this.indexPath(), serialized)
  }

  // Missing file: an empty canvas. Rejects with InvalidIdError, CorruptDataError, or UnsupportedVersionError.
  async loadCanvas(projectId: string): Promise<Canvas> {
    const loaded = await this.load(this.canvasSpec(projectId))
    return loaded ?? createEmptyCanvas(projectId)
  }

  async saveCanvas(canvas: Canvas): Promise<void> {
    const path = this.canvasPath((canvas as Partial<Canvas> | null)?.projectId)
    const serialized = serialize('canvas', canvas, parseCanvas)
    await this.save(path, serialized)
  }

  // Removes only SPADE's record of the canvas. A missing file is not an error.
  async deleteCanvas(projectId: string): Promise<void> {
    const path = this.canvasPath(projectId)
    await this.queue.run(path, async () => {
      await this.files.unlink(path).catch((error: unknown) => {
        if (!isFileNotFound(error)) throw error
      })
      this.refused.delete(path)
      this.writable.add(path)
    })
  }

  // Resolves once every write queued so far, and any queued meanwhile, has settled. Call before quitting.
  flush(): Promise<void> {
    return this.queue.idle()
  }

  private indexPath(): string {
    return join(this.directory, 'index.json')
  }

  private canvasPath(projectId: unknown): string {
    return join(this.directory, 'canvases', `${assertSafeId('project', projectId)}.json`)
  }

  private indexSpec(): DocumentSpec<AppIndex> {
    return {
      path: this.indexPath(),
      backupStem: 'index',
      migrations: this.migrations.index,
      parse: (document) => parseAppIndex({ ...document, settings: mergeSettingsOverDefaults(document.settings) })
    }
  }

  private canvasSpec(projectId: string): DocumentSpec<Canvas> {
    return {
      path: this.canvasPath(projectId),
      backupStem: `canvas-${projectId}`,
      migrations: this.migrations.canvas,
      parse: (document) => {
        const canvas = parseCanvas(document)
        if (canvas.projectId !== projectId) {
          throw new RecordValidationError('canvas.projectId', `must be ${projectId}, the project the file belongs to`)
        }
        return canvas
      }
    }
  }

  private load<Value>(spec: DocumentSpec<Value>): Promise<Value | null> {
    return this.queue.run(spec.path, async () => {
      let text: string
      try {
        text = await this.files.readFile(spec.path)
      } catch (error) {
        if (!isFileNotFound(error)) throw error
        this.writable.add(spec.path)
        return null
      }

      let document: unknown
      try {
        document = JSON.parse(text)
      } catch {
        throw await this.quarantine(spec, 'not valid JSON')
      }
      if (!isVersionedDocument(document)) throw await this.quarantine(spec, 'no format version')

      const version = document.version
      if (version > DOMAIN_RECORD_VERSION || !hasMigrationPath(spec.migrations, version, DOMAIN_RECORD_VERSION)) {
        throw this.refuse(spec.path, version)
      }

      let current: Record<string, unknown> = document
      if (version < DOMAIN_RECORD_VERSION) {
        await this.files.copyFile(spec.path, await this.freeBackupPath(`${spec.backupStem}.v${version}`))
        try {
          current = migrateDocument(document, spec.migrations, DOMAIN_RECORD_VERSION)
        } catch (error) {
          throw await this.quarantine(spec, `migration from format ${version} failed: ${describe(error)}`)
        }
      }

      let value: Value
      try {
        value = spec.parse(current)
      } catch (error) {
        if (error instanceof RecordValidationError) throw await this.quarantine(spec, error.message)
        throw error
      }

      if (current !== document) await writeFileAtomically(this.files, spec.path, toJson(value))
      this.refused.delete(spec.path)
      this.writable.add(spec.path)
      return value
    })
  }

  private save(path: string, serialized: string): Promise<void> {
    return this.queue.run(path, async () => {
      await this.assertMayReplace(path)
      await writeFileAtomically(this.files, path, serialized)
      this.writable.add(path)
    })
  }

  // A save never replaces a file in another format that this store has not loaded and migrated.
  private async assertMayReplace(path: string): Promise<void> {
    const refusal = this.refused.get(path)
    if (refusal) throw refusal
    if (this.writable.has(path)) return

    let document: unknown
    try {
      document = JSON.parse(await this.files.readFile(path))
    } catch (error) {
      if (isFileNotFound(error) || error instanceof SyntaxError) return
      throw error
    }
    if (isVersionedDocument(document) && document.version !== DOMAIN_RECORD_VERSION) {
      throw this.refuse(path, document.version)
    }
  }

  private refuse(path: string, version: number): UnsupportedVersionError {
    const error = new UnsupportedVersionError(path, version, DOMAIN_RECORD_VERSION)
    this.refused.set(path, error)
    return error
  }

  private async quarantine(spec: DocumentSpec<unknown>, reason: string): Promise<CorruptDataError> {
    const backupPath = await this.freeBackupPath(`corrupt-${spec.backupStem}`)
    await this.files.rename(spec.path, backupPath)
    this.writable.add(spec.path)
    return new CorruptDataError(spec.path, backupPath, reason)
  }

  private async freeBackupPath(stem: string): Promise<string> {
    const backups = join(this.directory, 'backups')
    await this.files.mkdir(backups)
    // File-name-safe on Windows: no colons.
    const stamp = this.now().toISOString().replace(/[:.]/g, '-')
    for (let attempt = 0; ; attempt += 1) {
      const candidate = join(backups, `${stem}.${stamp}${attempt === 0 ? '' : `-${attempt}`}.json`)
      if (!(await this.files.exists(candidate))) return candidate
    }
  }
}

function isVersionedDocument(value: unknown): value is Record<string, unknown> & { version: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const version = (value as Record<string, unknown>).version
  return typeof version === 'number' && Number.isInteger(version) && version >= 1
}

// Validates and serializes at call time, so later mutation by the caller cannot change what is written.
function serialize<Value>(what: string, value: Value, parse: (value: unknown) => unknown): string {
  try {
    parse(value)
  } catch (error) {
    if (error instanceof RecordValidationError) throw new InvalidRecordError(what, error.message)
    throw error
  }
  return toJson(value)
}

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
