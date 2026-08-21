import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

export async function emitValidationResult(
  outputPath: string | undefined,
  result: Record<string, unknown>
): Promise<void> {
  const serialized = `${JSON.stringify(result, null, 2)}\n`
  if (outputPath) await writeFile(outputPath, serialized, 'utf8')
  process.stdout.write(serialized)
}

export function isDirectEntry(importMetaUrl: string): boolean {
  const entryPath = process.argv[1]
  return Boolean(entryPath && importMetaUrl === pathToFileURL(resolve(entryPath)).href)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
