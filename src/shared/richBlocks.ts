// Contract for agent-authored rich answers (plan §11).

// A fenced Markdown block whose info string starts with this word renders as a live HTML answer:
//   ```spade-html Optional title
//   <!doctype html> ... complete document ...
//   ```
// A plain ```html fence stays a highlighted code block that the user may choose to render.
export const LIVE_HTML_FENCE = 'spade-html'

export type SpadeSubmitInput = { message?: string; data?: unknown }
export type SpadeAnnotateInput = { target?: string; text: string; data?: unknown }

// The API injected into every HTML answer runtime as `window.spade`.
export type SpadeAnswerApi = {
  submit(input: SpadeSubmitInput): Promise<void>
  annotate(input: SpadeAnnotateInput): Promise<void>
}

export type SpadeBridgeCall =
  | { method: 'submit'; input: SpadeSubmitInput }
  | { method: 'annotate'; input: SpadeAnnotateInput }

// Validates a call received from agent-authored script; anything malformed is rejected whole.
export function parseBridgeCall(method: unknown, input: unknown): SpadeBridgeCall | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>

  if (method === 'submit') {
    if (!hasOnlyKeys(record, ['message', 'data'])) return null
    if (!('message' in record) && !('data' in record)) return null
    if (record.message !== undefined && typeof record.message !== 'string') return null
    return { method, input: pick(record, ['message', 'data']) as SpadeSubmitInput }
  }

  if (method === 'annotate') {
    if (!hasOnlyKeys(record, ['target', 'text', 'data'])) return null
    if (typeof record.text !== 'string') return null
    if (record.target !== undefined && typeof record.target !== 'string') return null
    return { method, input: pick(record, ['target', 'text', 'data']) as SpadeAnnotateInput }
  }

  return null
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key))
}

function pick(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]))
}
