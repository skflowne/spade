import {
  CONVERSATION_FIELD_LIMIT,
  CONVERSATION_IMAGE_DATA_LIMIT,
  CONVERSATION_MESSAGE_TEXT_LIMIT,
  type ConversationImage,
  type ConversationItem,
  type ToolCallStatus
} from '../../shared/agents'

// Maps Paseo timeline rows to SPADE's provider-neutral conversation items. Pure: no daemon access.

export type PaseoTimelineRow = {
  item: unknown
  timestamp: string
  // First and last canonical sequence the (projected) row covers; absent on legacy rows.
  seqStart?: number
  seqEnd?: number
}

const SUMMARY_LIMIT = 240

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
}

type Item = Record<string, unknown>
type ToolCallFields = Extract<ConversationItem, { kind: 'tool-call' }>

export function normalizeTimeline(rows: readonly PaseoTimelineRow[], epoch: string | null): ConversationItem[] {
  const byId = new Map<string, { order: number; timestamp: string; item: ConversationItem }>()
  for (const row of rows) {
    const id = rowId(row, epoch)
    byId.set(id, {
      order: row.seqStart ?? Number.MAX_SAFE_INTEGER,
      timestamp: row.timestamp,
      item: normalizeTimelineItem(row.item, id, row.timestamp)
    })
  }
  return [...byId.values()]
    .sort((left, right) =>
      left.order - right.order ||
      left.timestamp.localeCompare(right.timestamp) ||
      left.item.id.localeCompare(right.item.id))
    .map(({ item }) => item)
}

export function normalizeTimelineItem(value: unknown, id: string, timestamp: string): ConversationItem {
  const base = { id, timestamp }
  const item: Item = isRecord(value) ? value : { type: typeof value }
  switch (item.type) {
    case 'user_message':
      // Paseo 0.17 timelines carry no message images; `images` stays empty until they do.
      return { ...base, kind: 'user-message', text: messageText(item.text), images: [], sender: null }
    case 'assistant_message':
      return { ...base, kind: 'assistant-message', text: messageText(item.text), images: [] }
    case 'reasoning':
      return { ...base, kind: 'thinking', text: bounded(stringOr(item.text, '')) }
    case 'tool_call': {
      // Paseo records input from another agent as a synthetic tool call carrying its provenance.
      const agentMessage = isRecord(item.agentMessage) ? item.agentMessage : null
      const sender = agentMessage && isRecord(agentMessage.sender) ? agentMessage.sender : null
      if (agentMessage && sender && typeof sender.id === 'string') {
        return {
          ...base,
          kind: 'user-message',
          text: messageText(agentMessage.text),
          images: [],
          sender: { agentId: sender.id, title: typeof sender.title === 'string' ? sender.title : null }
        }
      }
      return { ...base, ...toolCall(item) }
    }
    case 'todo':
      return {
        ...base,
        kind: 'todo',
        items: (Array.isArray(item.items) ? item.items : []).filter(isRecord).map((entry) => ({
          text: bounded(stringOr(entry.text, '')),
          done: entry.completed === true
        }))
      }
    case 'error':
      return { ...base, kind: 'error', message: bounded(stringOr(item.message, 'Unknown error')) }
    case 'notification': {
      const message = bounded(stringOr(item.message, ''))
      return item.level === 'error' ? { ...base, kind: 'error', message } : { ...base, kind: 'notice', text: message }
    }
    case 'compaction':
      return {
        ...base,
        kind: 'notice',
        text: item.status === 'loading' ? 'Compacting conversation…' : 'Conversation compacted'
      }
    case 'plugin':
      return { ...base, kind: 'notice', text: oneLine(`Plugin item ${String(item.pluginId)}/${String(item.kind)}`) }
    default:
      return { ...base, kind: 'notice', text: oneLine(`Unsupported timeline item “${String(item.type)}”`) }
  }
}

// Truncates to `limit` characters including a visible marker.
export function boundText(text: string, limit: number): string {
  if (text.length <= limit) return text
  const longestMarker = `\n…[truncated ${text.length} characters]`.length
  const keep = Math.max(0, limit - longestMarker)
  return `${text.slice(0, keep)}\n…[truncated ${text.length - keep} characters]`
}

function toolCall(item: Item): Omit<ToolCallFields, 'id' | 'timestamp'> {
  const detail: Item = isRecord(item.detail) ? item.detail : { type: 'unknown', input: null, output: null }
  const name = stringOr(item.name, 'tool')
  const fields: Omit<ToolCallFields, 'id' | 'timestamp'> = {
    kind: 'tool-call',
    callId: stringOr(item.callId, ''),
    toolKind: 'other',
    name,
    status: toolStatus(item.status),
    summary: name,
    input: null,
    output: null,
    error: item.status === 'failed' ? nullableBounded(errorText(item.error)) : null,
    diff: null,
    path: null,
    images: []
  }
  const text = (key: string): string | null => (typeof detail[key] === 'string' ? (detail[key] as string) : null)

  switch (detail.type) {
    case 'shell': {
      const command = text('command') ?? ''
      const exitCode = typeof detail.exitCode === 'number' && detail.exitCode !== 0 ? `\n[exit code ${detail.exitCode}]` : ''
      const output = text('output')
      return {
        ...fields,
        toolKind: 'shell',
        summary: summary(command, name),
        input: nullableBounded(command),
        output: output === null && !exitCode ? null : bounded(`${output ?? ''}${exitCode}`)
      }
    }
    case 'read': {
      const path = text('filePath')
      return {
        ...fields,
        toolKind: 'read',
        summary: summary(path, name),
        output: nullableBounded(text('content')),
        path,
        images: path ? imageFromPath(path) : []
      }
    }
    case 'edit': {
      const path = text('filePath')
      const providerDiff = text('unifiedDiff')
      const derived = providerDiff ?? (text('newString') !== null ? deriveDiff(path ?? '', text('oldString') ?? '', text('newString')!) : null)
      return { ...fields, toolKind: 'edit', summary: summary(path, name), path, diff: nullableBounded(derived) }
    }
    case 'write': {
      const path = text('filePath')
      const content = text('content')
      return {
        ...fields,
        toolKind: 'edit',
        summary: summary(path, name),
        path,
        diff: content === null ? null : bounded(deriveDiff(path ?? '', null, content))
      }
    }
    case 'search': {
      const query = text('query') ?? ''
      const files = Array.isArray(detail.filePaths) ? detail.filePaths.filter((entry) => typeof entry === 'string') : []
      const links = Array.isArray(detail.webResults)
        ? detail.webResults.filter(isRecord).map((result) => `${String(result.title)} — ${String(result.url)}`)
        : []
      const output = text('content') ?? (files.length ? files.join('\n') : links.length ? links.join('\n') : null)
      return { ...fields, toolKind: 'search', summary: summary(query, name), input: nullableBounded(query), output: nullableBounded(output) }
    }
    case 'fetch':
      return {
        ...fields,
        toolKind: 'fetch',
        summary: summary(text('url'), name),
        input: nullableBounded(text('prompt')),
        output: nullableBounded(text('result'))
      }
    case 'sub_agent': {
      const description = text('description')
      return {
        ...fields,
        toolKind: 'subagent',
        summary: summary(description ?? text('subAgentType'), name),
        input: nullableBounded(description),
        output: nullableBounded(text('log') || null)
      }
    }
    case 'plain_text':
      return { ...fields, summary: summary(text('label') ?? text('text'), name), output: nullableBounded(text('text')) }
    case 'plan':
      return { ...fields, summary: summary(text('text'), name), output: nullableBounded(text('text')) }
    case 'worktree_setup':
      return { ...fields, summary: summary(`Set up worktree ${text('branchName') ?? ''}`, name), output: nullableBounded(text('log')) }
    default: {
      const input = detail.input === undefined || detail.input === null ? null : stableStringify(detail.input)
      const images: ConversationImage[] = []
      const omitted: string[] = []
      collectImages(detail.output, images, omitted)
      const carriesImages = images.length > 0 || omitted.length > 0
      const outputText = contentText(detail.output) ??
        (detail.output === undefined || detail.output === null || carriesImages ? null : stableStringify(detail.output))
      const output = [outputText, ...omitted].filter((part): part is string => Boolean(part)).join('\n') || null
      return {
        ...fields,
        summary: summary(input ? `${name} ${input}` : name, name),
        input: nullableBounded(input),
        output: nullableBounded(output),
        images
      }
    }
  }
}

// One hunk: shared leading and trailing lines become context, the rest is replaced.
function deriveDiff(path: string, oldText: string | null, newText: string): string {
  const before = oldText ? oldText.split('\n') : []
  const after = newText ? newText.split('\n') : []
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1
  const hunk = (lines: string[]) => `${lines.length ? 1 : 0},${lines.length}`
  return [
    oldText === null ? '--- /dev/null' : `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${hunk(before)} +${hunk(after)} @@`,
    ...before.slice(0, prefix).map((line) => ` ${line}`),
    ...before.slice(prefix, before.length - suffix).map((line) => `-${line}`),
    ...after.slice(prefix, after.length - suffix).map((line) => `+${line}`),
    ...before.slice(before.length - suffix).map((line) => ` ${line}`)
  ].join('\n')
}

function imageFromPath(path: string): ConversationImage[] {
  // Relative paths depend on the agent's cwd, which this pure mapping does not know.
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) return []
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase()
  const mimeType = extension ? IMAGE_MIME_TYPES[extension] : undefined
  return mimeType ? [{ source: path, mimeType }] : []
}

// MCP-style `{ type: 'image', data, mimeType }` blocks and Anthropic-style base64 sources.
function collectImages(value: unknown, images: ConversationImage[], omitted: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectImages(entry, images, omitted)
    return
  }
  if (!isRecord(value)) return
  if (value.type === 'image') {
    const source = isRecord(value.source) ? value.source : value
    const data = typeof source.data === 'string' ? source.data : null
    const mimeType = typeof source.mimeType === 'string'
      ? source.mimeType
      : typeof source.media_type === 'string' ? source.media_type : null
    if (data && mimeType) {
      const url = `data:${mimeType};base64,${data}`
      if (url.length <= CONVERSATION_IMAGE_DATA_LIMIT) images.push({ source: url, mimeType })
      else omitted.push(`[image omitted: ${url.length} characters]`)
    }
    return
  }
  collectImages(value.content, images, omitted)
}

function contentText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => (typeof entry === 'string' ? entry : isRecord(entry) && entry.type === 'text' ? entry.text : null))
      .filter((part): part is string => typeof part === 'string')
    return parts.length ? parts.join('\n') : null
  }
  if (isRecord(value)) {
    if (value.content !== undefined) return contentText(value.content)
    if (typeof value.output === 'string') return value.output
    if (typeof value.text === 'string') return value.text
  }
  return null
}

function errorText(error: unknown): string | null {
  if (error === null || error === undefined) return null
  if (typeof error === 'string') return error
  if (isRecord(error)) {
    const content = contentText(error.content)
    if (content) return content
    if (typeof error.message === 'string') return error.message
  }
  return stableStringify(error)
}

function toolStatus(value: unknown): ToolCallStatus {
  return value === 'completed' || value === 'failed' || value === 'canceled' ? value : 'running'
}

function rowId(row: PaseoTimelineRow, epoch: string | null): string {
  if (epoch && typeof row.seqStart === 'number') return `${epoch}:${row.seqStart}`
  return `item:${fingerprint(`${row.timestamp}\u0000${stableStringify(row.item)}`)}`
}

function summary(value: string | null | undefined, fallback: string): string {
  const line = oneLine(value ?? '')
  return line || oneLine(fallback)
}

function oneLine(value: string): string {
  const firstLine = value.trim().split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? ''
  return firstLine.length > SUMMARY_LIMIT ? `${firstLine.slice(0, SUMMARY_LIMIT - 1)}…` : firstLine
}

function messageText(value: unknown): string {
  return boundText(stringOr(value, ''), CONVERSATION_MESSAGE_TEXT_LIMIT)
}

function bounded(value: string): string {
  return boundText(value, CONVERSATION_FIELD_LIMIT)
}

function nullableBounded(value: string | null): string | null {
  return value === null ? null : bounded(value)
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function fingerprint(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function isRecord(value: unknown): value is Item {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
