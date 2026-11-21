import { Lexer } from 'marked'
import { LIVE_HTML_FENCE } from '../../../../shared/richBlocks'

// An assistant message split at its top-level live HTML answers, so each answer gets its own collapsible
// frame and annotation list. A fence still being streamed is pending: rendering it would restart the
// answer runtime or the diagram on every chunk.
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
    if (token.type === 'code' && FENCE_START.test(token.raw)) {
      const [word = '', ...titleWords] = (token.lang ?? '').trim().split(/\s+/)
      const language = word.toLowerCase()
      if (RESTARTING_FENCES.has(language) && index === tokens.length - 1 && !isClosedFence(token.raw)) {
        flush()
        segments.push({ type: 'pending', language })
        return
      }
      if (language === LIVE_HTML_FENCE) {
        flush()
        segments.push({ type: 'html', html: token.text, title: titleWords.join(' ') || null })
        return
      }
    }
    markdown += token.raw
  })
  flush()
  return segments
}

function isClosedFence(raw: string): boolean {
  const opening = FENCE_START.exec(raw)?.[1]
  if (opening === undefined) return true
  const lines = raw.trimEnd().split('\n')
  const closing = lines.length > 1 ? lines[lines.length - 1].trim() : ''
  return closing.length >= opening.length && closing === opening[0].repeat(closing.length)
}
