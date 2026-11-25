import { InvalidIdError } from './errors'

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
// Windows refuses these as file names regardless of extension.
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

// Ids that become file names: no separators, dots, or drive syntax can survive this check.
export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID_PATTERN.test(id) && !WINDOWS_DEVICE_NAME.test(id)
}

export function assertSafeId(kind: string, id: unknown): string {
  if (!isSafeId(id)) throw new InvalidIdError(kind, String(id))
  return id
}
