// Detects actionable artifacts (URLs and file paths) in plain conversation text (plan §7.1).
// Detection is purely lexical: existence is checked lazily by the host, so a false positive
// renders as a disabled chip rather than failing. Relative-path rules stay conservative so
// ordinary prose ("and/or", "TCP/IP", dates, versions) is never matched.

export type ArtifactKind = 'url' | 'path'

export type Artifact = {
  kind: ArtifactKind
  // The URL as written, or the path without surrounding quotes and without its :line:col suffix.
  value: string
  line: number | null
  column: number | null
  isImage: boolean
}

export type TextSegment = { type: 'text'; text: string; start: number; end: number }
export type ArtifactSegment = { type: 'artifact'; text: string; start: number; end: number; artifact: Artifact }
// Segments cover the input exactly and in order; `start`/`end` index into the input.
export type DetectedSegment = TextSegment | ArtifactSegment

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi
// Characters that end an unquoted path token. Paths containing these must be quoted or backticked.
const UNQUOTED_TOKEN_PATTERN = /[^\s"'`<>|,;=(){}*?]+/g
const QUOTES = new Set(['"', "'", '`'])
const TRAILING_PUNCTUATION = new Set(['.', ',', ':', ';', '!', '?', "'", '"'])
const CLOSING_BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{', '>': '<' }
const LOCATION_SUFFIX = /:(\d+)(?::(\d+)|-\d+)?$/
const EXTENSION = /\.([A-Za-z][A-Za-z0-9]{0,9})$/
const DOMAIN_LIKE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/
const FORBIDDEN_PATH_CHARS = /[<>|"*?]/

type Claim = { start: number; end: number; artifact: Artifact }

export function detectArtifacts(text: string): DetectedSegment[] {
  const claims: Claim[] = []
  const isFree = (start: number, end: number): boolean =>
    claims.every((claim) => end <= claim.start || start >= claim.end)

  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = trimUrl(match[0])
    const artifact = parseUrl(raw)
    if (artifact) claims.push({ start: match.index, end: match.index + raw.length, artifact })
  }

  for (const quoted of findQuotedSpans(text)) {
    if (!isFree(quoted.start - 1, quoted.end + 1)) continue
    const artifact = parsePath(quoted.content, true)
    if (artifact) claims.push({ start: quoted.start, end: quoted.end, artifact })
  }

  for (const gap of gaps(text, claims)) {
    for (const match of text.slice(gap.start, gap.end).matchAll(UNQUOTED_TOKEN_PATTERN)) {
      const trimmed = trimToken(match[0])
      if (!trimmed) continue
      const start = gap.start + match.index + trimmed.offset
      const artifact = parsePath(trimmed.token, false)
      if (artifact) claims.push({ start, end: start + trimmed.token.length, artifact })
    }
  }

  return toSegments(text, claims)
}

// Classifies a whole string (an inline code span, a quoted value) as one artifact. Spaces are allowed
// because the caller already knows where the candidate begins and ends.
export function parseArtifact(candidate: string): Artifact | null {
  const value = candidate.trim()
  if (!value) return null
  if (/^https?:\/\//i.test(value)) return trimUrl(value) === value ? parseUrl(value) : null
  return parsePath(value, true)
}

// Builds a path artifact without the conservative prose filter, for targets an author explicitly
// marked as links (e.g. a Markdown link to `docs/plan`).
export function pathArtifact(raw: string): Artifact {
  const { path, line, column } = splitLocation(raw.trim())
  return { kind: 'path', value: path, line, column, isImage: hasImageExtension(path) }
}

export function hasImageExtension(path: string): boolean {
  const extension = EXTENSION.exec(path)?.[1]
  return extension !== undefined && IMAGE_EXTENSIONS.has(extension.toLowerCase())
}

function parseUrl(raw: string): Artifact | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return null
  return { kind: 'url', value: raw, line: null, column: null, isImage: hasImageExtension(parsed.pathname) }
}

function trimUrl(raw: string): string {
  let url = raw
  for (;;) {
    const last = url.at(-1)
    if (last === undefined) return url
    if (TRAILING_PUNCTUATION.has(last)) {
      url = url.slice(0, -1)
      continue
    }
    const opening = CLOSING_BRACKETS[last]
    if (opening !== undefined && count(url, opening) < count(url, last)) {
      url = url.slice(0, -1)
      continue
    }
    return url
  }
}

function trimToken(raw: string): { token: string; offset: number } | null {
  let token = raw
  let offset = 0
  if (token.startsWith('[')) {
    const close = token.indexOf(']')
    const separator = token.search(/[\\/]/)
    if (close === -1 || (separator !== -1 && close > separator)) {
      token = token.slice(1)
      offset = 1
    }
  }
  for (;;) {
    const last = token.at(-1)
    if (last === undefined) return null
    if (TRAILING_PUNCTUATION.has(last) || (last === ']' && count(token, '[') < count(token, ']'))) {
      token = token.slice(0, -1)
      continue
    }
    return { token, offset }
  }
}

function parsePath(raw: string, allowSpaces: boolean): Artifact | null {
  if (raw !== raw.trim() || (!allowSpaces && /\s/.test(raw))) return null
  const fileUrl = /^file:\/\/(\/[A-Za-z]:[\\/]|\/)/i.exec(raw)
  const candidate = fileUrl ? decodeFileUrl(raw) : raw
  if (candidate === null) return null

  const { path, line, column } = splitLocation(candidate)
  if (!path || FORBIDDEN_PATH_CHARS.test(path) || hasControlCharacter(path) || !isPlausiblePath(path)) return null
  return { kind: 'path', value: path, line, column, isImage: hasImageExtension(path) }
}

function hasControlCharacter(path: string): boolean {
  for (let index = 0; index < path.length; index += 1) {
    if (path.charCodeAt(index) < 32) return true
  }
  return false
}

function decodeFileUrl(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw.replace(/^file:\/\//i, ''))
    return /^\/[A-Za-z]:[\\/]/.test(decoded) ? decoded.slice(1) : decoded
  } catch {
    return null
  }
}

function splitLocation(raw: string): { path: string; line: number | null; column: number | null } {
  const match = LOCATION_SUFFIX.exec(raw)
  if (!match || Number(match[1]) < 1) return { path: raw, line: null, column: null }
  return {
    path: raw.slice(0, match.index),
    line: Number(match[1]),
    column: match[2] === undefined ? null : Number(match[2])
  }
}

function isPlausiblePath(path: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(path)) return validSegments(segmentsOf(path.slice(3)), true)
  if (/^\\\\[^\\/\s]+[\\/][^\\/\s]+/.test(path)) return validSegments(segmentsOf(path.slice(2)), true)

  if (path.startsWith('/')) {
    const segments = segmentsOf(path.slice(1))
    if (!validSegments(segments, true)) return false
    const named = segments.filter(Boolean)
    return named.length >= 2 || (named.length === 1 && hasExtension(named[0]))
  }

  if (/^\.\.?[\\/]/.test(path)) {
    const segments = segmentsOf(path.replace(/^\.\.?[\\/]/, ''))
    return segments.some(Boolean) && validSegments(segments, true)
  }

  if (!/[\\/]/.test(path) || path.includes(':')) return false
  const segments = segmentsOf(path)
  if (!validSegments(segments, false)) return false
  const named = segments.filter(Boolean)
  if (DOMAIN_LIKE.test(named[0]) && named.length > 1) return false
  const trailingSeparator = segments.at(-1) === ''
  if (trailingSeparator) return named.length >= 2 || named[0].length >= 2
  return hasExtension(named[named.length - 1])
}

function segmentsOf(path: string): string[] {
  return path.split(/\/|\\+/)
}

// Empty segments are only allowed at the end (a trailing separator); `absolute` paths may also
// contain drive-relative colons in their segments.
function validSegments(segments: string[], absolute: boolean): boolean {
  return segments.every((segment, index) => {
    if (segment === '') return index === segments.length - 1
    if (segment === '.' || segment === '..') return true
    if (segment.endsWith('.')) return false
    return absolute || !segment.includes(':')
  })
}

function hasExtension(segment: string): boolean {
  if (/^\.[A-Za-z][\w.-]*$/.test(segment)) return true
  const match = EXTENSION.exec(segment)
  return match !== null && match.index > 0
}

function findQuotedSpans(text: string): Array<{ start: number; end: number; content: string }> {
  const spans: Array<{ start: number; end: number; content: string }> = []
  let index = 0
  while (index < text.length) {
    const quote = text[index]
    if (!QUOTES.has(quote) || isWordChar(text[index - 1])) {
      index += 1
      continue
    }
    const close = text.indexOf(quote, index + 1)
    const lineEnd = text.indexOf('\n', index + 1)
    if (close === -1 || (lineEnd !== -1 && lineEnd < close) || isWordChar(text[close + 1])) {
      index += 1
      continue
    }
    const content = text.slice(index + 1, close)
    if (content && parsePath(content, true)) {
      spans.push({ start: index + 1, end: close, content })
      index = close + 1
    } else {
      index += 1
    }
  }
  return spans
}

function isWordChar(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character)
}

function gaps(text: string, claims: Claim[]): Array<{ start: number; end: number }> {
  const sorted = [...claims].sort((a, b) => a.start - b.start)
  const result: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const claim of sorted) {
    if (claim.start > cursor) result.push({ start: cursor, end: claim.start })
    cursor = Math.max(cursor, claim.end)
  }
  if (cursor < text.length) result.push({ start: cursor, end: text.length })
  return result
}

function toSegments(text: string, claims: Claim[]): DetectedSegment[] {
  const segments: DetectedSegment[] = []
  let cursor = 0
  for (const claim of [...claims].sort((a, b) => a.start - b.start)) {
    if (claim.start > cursor) {
      segments.push({ type: 'text', text: text.slice(cursor, claim.start), start: cursor, end: claim.start })
    }
    segments.push({
      type: 'artifact',
      text: text.slice(claim.start, claim.end),
      start: claim.start,
      end: claim.end,
      artifact: claim.artifact
    })
    cursor = claim.end
  }
  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor), start: cursor, end: text.length })
  return segments
}

function count(text: string, character: string): number {
  return text.split(character).length - 1
}
