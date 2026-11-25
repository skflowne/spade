import { Lexer, type Token, type Tokens } from 'marked'
import { LIVE_HTML_FENCE } from '../../../../shared/richBlocks'

// An assistant message split at its top-level live HTML answers, so each answer gets its own collapsible
// frame and annotation list. A fence still being streamed is pending: rendering it would restart the
// answer runtime or the diagram on every chunk. That holds for a fence nested in a list or a quote too.
export type MessageSegment =
  | { type: 'markdown'; source: string }
  | { type: 'html'; html: string; title: string | null }
  | { type: 'pending'; language: string }

const FENCE_START = /^[ \t]{0,3}(`{3,}|~{3,})/
// Fences whose renderer starts over whenever its text changes; ordinary code may stream visibly.
const RESTARTING_FENCES = new Set([LIVE_HTML_FENCE, 'mermaid'])

export function splitMessage(source: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  let markdown = ''
  const flush = (): void => {
    if (markdown) segments.push({ type: 'markdown', source: markdown })
    markdown = ''
  }
  const tokens = Lexer.lex(source, { gfm: true, breaks: false })
  tokens.forEach((token, index) => {
    const last = index === tokens.length - 1
    if (token.type === 'code' && FENCE_START.test(token.raw)) {
      const code = token as Tokens.Code
      if (last && isStreamingRestartingFence(code)) {
        flush()
        segments.push({ type: 'pending', language: fenceLanguage(code) })
        return
      }
      if (fenceLanguage(code) === LIVE_HTML_FENCE) {
        const [, ...titleWords] = (code.lang ?? '').trim().split(/\s+/)
        flush()
        segments.push({ type: 'html', html: code.text, title: titleWords.join(' ') || null })
        return
      }
    }
    const nested = last ? lastNestedCode(token) : null
    if (nested && isStreamingRestartingFence(nested)) {
      // The container's Markdown up to the line that opens the fence; the fence itself waits.
      const opening = nested.raw.split('\n', 1)[0].trim()
      const at = token.raw.lastIndexOf(opening)
      markdown += at === -1 ? '' : token.raw.slice(0, token.raw.lastIndexOf('\n', at) + 1)
      flush()
      segments.push({ type: 'pending', language: fenceLanguage(nested) })
      return
    }
    markdown += token.raw
  })
  flush()
  return segments
}

function fenceLanguage(token: Tokens.Code): string {
  return ((token.lang ?? '').trim().split(/\s+/, 1)[0] ?? '').toLowerCase()
}

function isStreamingRestartingFence(token: Tokens.Code): boolean {
  return FENCE_START.test(token.raw) && RESTARTING_FENCES.has(fenceLanguage(token)) && !isClosedFence(token.raw)
}

// The code block a list or quote ends with, however deeply nested.
function lastNestedCode(token: Token): Tokens.Code | null {
  let current: Token | undefined = token
  while (current?.type === 'list' || current?.type === 'list_item' || current?.type === 'blockquote') {
    const children: Token[] = current.type === 'list' ? (current as Tokens.List).items : ((current as Tokens.Blockquote).tokens ?? [])
    current = children.filter((child) => child.type !== 'space').at(-1)
    if (current?.type === 'code') return current as Tokens.Code
  }
  return null
}

function isClosedFence(raw: string): boolean {
  const opening = FENCE_START.exec(raw)?.[1]
  if (opening === undefined) return true
  const lines = raw.trimEnd().split('\n')
  const closing = lines.length > 1 ? lines[lines.length - 1].trim() : ''
  return closing.length >= opening.length && closing === opening[0].repeat(closing.length)
}
