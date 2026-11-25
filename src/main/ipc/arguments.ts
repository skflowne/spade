import { AGENT_TIMELINE_PAGE_LIMIT, type AgentTimelineQuery, type PermissionBehavior } from '../../shared/agents'
import { imageEntity, type ImageSource } from '../../shared/builtinEntities'
import type { PathAccessOptions } from '../../shared/ipc'

// Renderer arguments are untrusted: every handler checks them here before calling a service.
export class InvalidArgumentError extends Error {
  readonly code = 'invalid-argument'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidArgumentError'
  }
}

const ID_LENGTH_LIMIT = 256
const TEXT_LENGTH_LIMIT = 1_000_000

type Fields = Record<string, unknown>

export function id(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > ID_LENGTH_LIMIT) {
    throw new InvalidArgumentError(`${name} must be a non-empty string`)
  }
  return value
}

export function text(value: unknown, name: string, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string' || value.length > TEXT_LENGTH_LIMIT) {
    throw new InvalidArgumentError(`${name} must be a string`)
  }
  if (!options.allowEmpty && value.trim().length === 0) throw new InvalidArgumentError(`${name} must not be empty`)
  return value
}

export function fields(value: unknown, name: string, allowed: readonly string[]): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidArgumentError(`${name} must be an object`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new InvalidArgumentError(`${name}.${key} is not a known field`)
  }
  return value as Fields
}

export function settingsPatch(value: unknown): Fields {
  return fields(value, 'patch', ['agentDefaults', 'conversationExpansion', 'paseoUrl'])
}

export function timelineQuery(value: unknown): AgentTimelineQuery | undefined {
  if (value === undefined) return undefined
  const query = fields(value, 'query', ['before', 'limit'])
  const parsed: AgentTimelineQuery = {}
  if (query.before !== undefined) parsed.before = id(query.before, 'query.before')
  if (query.limit !== undefined) {
    const limit = query.limit
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > AGENT_TIMELINE_PAGE_LIMIT) {
      throw new InvalidArgumentError(`query.limit must be an integer from 1 to ${AGENT_TIMELINE_PAGE_LIMIT}`)
    }
    parsed.limit = limit
  }
  return parsed
}

export function promptInput(value: unknown): { text: string; contextNodeIds?: string[] } {
  const input = fields(value, 'input', ['text', 'contextNodeIds'])
  const parsed: { text: string; contextNodeIds?: string[] } = { text: text(input.text, 'input.text') }
  if (input.contextNodeIds !== undefined) {
    if (!Array.isArray(input.contextNodeIds)) throw new InvalidArgumentError('input.contextNodeIds must be an array')
    parsed.contextNodeIds = input.contextNodeIds.map((entry, index) => id(entry, `input.contextNodeIds[${index}]`))
  }
  return parsed
}

export function permissionBehavior(value: unknown): PermissionBehavior {
  if (value !== 'allow' && value !== 'deny') throw new InvalidArgumentError('behavior must be "allow" or "deny"')
  return value
}

export function pathAccess(value: unknown): PathAccessOptions | undefined {
  if (value === undefined) return undefined
  const options = fields(value, 'options', ['explicit'])
  if (options.explicit !== undefined && typeof options.explicit !== 'boolean') {
    throw new InvalidArgumentError('options.explicit must be a boolean')
  }
  return options.explicit === undefined ? {} : { explicit: options.explicit }
}

export function imageSource(value: unknown): ImageSource {
  try {
    return imageEntity.parseConfig({ source: value }).source
  } catch (error) {
    throw new InvalidArgumentError(`source is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function webUrl(value: unknown): string {
  const url = text(value, 'url')
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    throw new InvalidArgumentError('url must be an absolute URL')
  }
  if (protocol !== 'http:' && protocol !== 'https:') throw new InvalidArgumentError('url must be an http or https URL')
  return url
}

export function imageData(value: unknown): { data: ArrayBuffer; mimeType: string } {
  const input = fields(value, 'input', ['data', 'mimeType'])
  const data = input.data
  let buffer: ArrayBuffer
  if (data instanceof ArrayBuffer) {
    buffer = data
  } else if (ArrayBuffer.isView(data)) {
    buffer = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer
  } else {
    throw new InvalidArgumentError('input.data must be an ArrayBuffer')
  }
  return { data: buffer, mimeType: id(input.mimeType, 'input.mimeType') }
}
