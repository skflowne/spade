// Windows-first path logic as pure string handling (plan §4.7). Never imports node:path: the same rules must
// hold on Linux test machines and in the sandboxed renderer. POSIX `/…` paths are accepted for development.

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] as const

type Separator = '\\' | '/'

type ParsedPath = {
  root:
    | { kind: 'drive'; drive: string }
    | { kind: 'unc'; server: string; share: string }
    // A path starting with one separator: POSIX absolute, or rooted on the current Windows drive.
    | { kind: 'rooted' }
    | { kind: 'relative' }
  // `\\?\` or `\\.\`: Win32 long-path and device namespaces, which only accept backslashes.
  prefix: '\\\\?\\' | '\\\\.\\' | null
  segments: string[]
}

const SEPARATORS = /[\\/]+/
const LONG_PREFIX = /^[\\/]{2}[?.][\\/]/
const DRIVE = /^[A-Za-z]:(?=[\\/]|$)/

function parsePath(path: string): ParsedPath {
  const parts = (rest: string) => rest.split(SEPARATORS).filter((part) => part.length > 0)

  if (LONG_PREFIX.test(path)) {
    const prefix = path[2] === '?' ? '\\\\?\\' : '\\\\.\\'
    const rest = path.slice(4)
    if (/^UNC([\\/]|$)/i.test(rest)) {
      const [server = '', share = '', ...segments] = parts(rest.slice(3))
      return { root: { kind: 'unc', server, share }, prefix, segments }
    }
    // A drive (`C:`) or another device name (`Volume{…}`) acts as the root.
    const [drive = '', ...segments] = parts(rest)
    return { root: { kind: 'drive', drive }, prefix, segments }
  }
  if (/^[\\/]{2}[^\\/]/.test(path)) {
    const [server = '', share = '', ...segments] = parts(path)
    return { root: { kind: 'unc', server, share }, prefix: null, segments }
  }
  if (DRIVE.test(path)) {
    return { root: { kind: 'drive', drive: path.slice(0, 2) }, prefix: null, segments: parts(path.slice(2)) }
  }
  if (/^[\\/]/.test(path)) return { root: { kind: 'rooted' }, prefix: null, segments: parts(path) }
  return { root: { kind: 'relative' }, prefix: null, segments: parts(path) }
}

// Resolves `.` and `..`; `..` never climbs above an absolute root.
function normalizeSegments(parsed: ParsedPath): ParsedPath {
  const segments: string[] = []
  for (const segment of parsed.segments) {
    if (segment === '.') continue
    if (segment !== '..') segments.push(segment)
    else if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop()
    else if (parsed.root.kind === 'relative') segments.push('..')
  }
  return { ...parsed, segments }
}

function formatPath(parsed: ParsedPath, separator: Separator): string {
  const sep = parsed.prefix ? '\\' : separator
  const tail = parsed.segments.join(sep)
  const { root } = parsed
  switch (root.kind) {
    case 'drive':
      return `${parsed.prefix ?? ''}${root.drive}${sep}${tail}`
    case 'unc': {
      const share = parsed.prefix
        ? `${parsed.prefix}UNC\\${root.server}\\${root.share}`
        : `${sep}${sep}${root.server}${sep}${root.share}`
      return tail ? `${share}${sep}${tail}` : share
    }
    case 'rooted':
      return `${sep}${tail}`
    case 'relative':
      return tail || '.'
  }
}

function separatorOf(path: string): Separator {
  if (LONG_PREFIX.test(path)) return '\\'
  const match = /[\\/]/.exec(path)
  return match ? (match[0] as Separator) : '\\'
}

// Normalized, case-insensitive form for comparing paths. Never stored or displayed.
export function pathKey(path: string): string {
  const parsed = normalizeSegments(parsePath(path))
  return formatPath({ ...parsed, prefix: null }, '\\').toLowerCase()
}

export function isSamePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b)
}

// Strictly inside: a directory is not inside itself.
export function isPathInside(path: string, directory: string): boolean {
  const pathId = pathKey(path)
  const directoryId = pathKey(directory)
  const prefix = directoryId.endsWith('\\') ? directoryId : `${directoryId}\\`
  return pathId !== directoryId && pathId.startsWith(prefix)
}

// A path whose access may contact another machine: a UNC share in any spelling, or a `\\?\` / `\\.\` device
// path that is not a drive letter (device namespaces reach shares too, through GLOBALROOT\Device\Mup).
// On Windows, touching one opens an SMB connection and may send the user's credentials.
export function isNetworkPath(path: string): boolean {
  const parsed = parsePath(path)
  if (parsed.root.kind === 'unc') return true
  return parsed.prefix !== null && !/^[A-Za-z]:$/.test(parsed.root.kind === 'drive' ? parsed.root.drive : '')
}

// SPADE never touches a network path because of text it was given unless the user approved it; the project
// root and everything inside it are approved by opening the project.
export function needsNetworkApproval(path: string, projectRoot: string): boolean {
  return isNetworkPath(path) && !isSamePath(path, projectRoot) && !isPathInside(path, projectRoot)
}

export function isAbsolutePath(path: string): boolean {
  return parsePath(path).root.kind !== 'relative'
}

// An absolute `path` is only normalized, in its own separator style. A relative one is joined to `root`
// and normalized in the root's separator style, so paths read back the way the user selected the root.
export function resolveProjectPath(root: string, path: string): string {
  if (isAbsolutePath(path)) return formatPath(normalizeSegments(parsePath(path)), separatorOf(path))
  const parsedRoot = parsePath(root)
  const joined = { ...parsedRoot, segments: [...parsedRoot.segments, ...parsePath(path).segments] }
  return formatPath(normalizeSegments(joined), separatorOf(root))
}

// Splits `file:line` and `file:line:column` as written in agent output. Lines and columns are 1-based.
export function splitLineSuffix(text: string): { path: string; line: number | null; column: number | null } {
  const match = /^(.+?):([1-9]\d*)(?::([1-9]\d*))?$/.exec(text)
  // A single letter before the colon is a drive (`C:12`), not a file.
  if (!match || /^[A-Za-z]$/.test(match[1])) return { path: text, line: null, column: null }
  return { path: match[1], line: Number(match[2]), column: match[3] === undefined ? null : Number(match[3]) }
}

// The last segment, or the root itself (`C:`, the share name) when there is none.
export function pathBaseName(path: string): string {
  const parsed = parsePath(path)
  const last = parsed.segments[parsed.segments.length - 1]
  if (last !== undefined) return last
  switch (parsed.root.kind) {
    case 'drive':
      return parsed.root.drive
    case 'unc':
      return parsed.root.share
    default:
      return ''
  }
}

export function isImagePath(path: string): boolean {
  const name = pathBaseName(path)
  if (/[\\/]$/.test(path)) return false
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return (IMAGE_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1).toLowerCase())
}
