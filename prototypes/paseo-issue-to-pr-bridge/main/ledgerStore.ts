import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isPrototypeLedger, migratePrototypeLedger, type PrototypeLedger } from '../shared/model'

export type LedgerFileOperations = {
  mkdir(path: string): Promise<void>
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

export const nodeLedgerFileOperations: LedgerFileOperations = {
  mkdir: async (path) => mkdir(path, { recursive: true }).then(() => undefined),
  readFile: async (path) => readFile(path, 'utf8'),
  writeFile: async (path, data) => writeFile(path, data, 'utf8'),
  rename,
  unlink
}

export class LedgerStore {
  constructor(
    readonly path: string,
    private readonly files: LedgerFileOperations = nodeLedgerFileOperations
  ) {}

  async load(): Promise<PrototypeLedger | null> {
    let serialized: string
    try {
      serialized = await this.files.readFile(this.path)
    } catch (error) {
      if (isFileNotFound(error)) return null
      throw error
    }

    let value: unknown
    try {
      value = JSON.parse(serialized)
    } catch {
      throw new Error('Invalid P3 prototype ledger: file is not valid JSON.')
    }
    const ledger = migratePrototypeLedger(value)
    if (!ledger) throw new Error('Invalid P3 prototype ledger: records are malformed.')
    return ledger
  }

  async save(ledger: PrototypeLedger): Promise<void> {
    if (!isPrototypeLedger(ledger)) throw new Error('Invalid P3 prototype ledger: refusing to persist malformed records.')

    const directory = dirname(this.path)
    const temporaryPath = join(
      directory,
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`
    )
    await this.files.mkdir(directory)

    try {
      await this.files.writeFile(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`)
      await this.files.rename(temporaryPath, this.path)
    } catch (error) {
      await this.files.unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
