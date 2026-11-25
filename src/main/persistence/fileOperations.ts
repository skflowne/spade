import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

// The only filesystem surface the stores use, injectable so tests can fail any step.
export type PersistenceFileOperations = {
  mkdir(path: string): Promise<void>
  readFile(path: string): Promise<string>
  // Creates `path`, failing if it exists, and flushes it to disk before resolving.
  writeNewFile(path: string, data: string | Uint8Array): Promise<void>
  // Replaces `to` if it exists.
  rename(from: string, to: string): Promise<void>
  // Fails if `to` exists.
  copyFile(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  exists(path: string): Promise<boolean>
}

// Windows reports these while another process (an indexer or antivirus) briefly holds the target.
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_ATTEMPTS = 5

export const nodeFileOperations: PersistenceFileOperations = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true })
  },
  readFile: (path) => readFile(path, 'utf8'),
  writeNewFile: async (path, data) => {
    const handle = await open(path, 'wx')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
  rename: async (from, to) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await rename(from, to)
      } catch (error) {
        if (attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME_ERRORS.has(errorCode(error) ?? '')) throw error
        await new Promise((resolve) => setTimeout(resolve, attempt * 20))
      }
    }
  },
  copyFile: (from, to) => copyFile(from, to, constants.COPYFILE_EXCL),
  unlink,
  exists: (path) =>
    access(path).then(
      () => true,
      (error: unknown) => {
        if (isFileNotFound(error)) return false
        throw error
      }
    )
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

export function isFileNotFound(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

// Writes to a temporary sibling, then renames over `path`; on any failure the temporary file is
// removed and the previous `path` is left as it was.
export async function writeFileAtomically(
  files: PersistenceFileOperations,
  path: string,
  data: string | Uint8Array
): Promise<void> {
  const directory = dirname(path)
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  await files.mkdir(directory)
  try {
    await files.writeNewFile(temporaryPath, data)
    await files.rename(temporaryPath, path)
  } catch (error) {
    await files.unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

// Runs tasks one at a time per key, in call order. A failed task does not block the ones after it.
export class SerialQueue {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<Result>(key: string, task: () => Promise<Result>): Promise<Result> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(task)
    const tail = result.catch(() => undefined)
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }

  // Resolves once every queued task, including ones queued while waiting, has settled.
  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all(this.tails.values())
  }
}
