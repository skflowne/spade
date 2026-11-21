import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ControlDiscovery } from './protocol'

// Readers never see a half-written file: content goes to a private temporary file that replaces the target.
// `mode` is applied at creation; Windows ignores it and relies on the per-user data directory's ACL.
export async function writeFileAtomic(path: string, content: string, mode: number): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode, flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

export async function writeDiscoveryFile(path: string, discovery: ControlDiscovery): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(discovery, null, 2)}\n`, 0o600)
}

// Removes the file only while it still names this server, so a newer instance's file survives.
export async function removeDiscoveryFile(path: string, token: string): Promise<void> {
  let current: unknown
  try {
    current = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return
  }
  if (typeof current === 'object' && current !== null && (current as { token?: unknown }).token === token) {
    await rm(path, { force: true })
  }
}
