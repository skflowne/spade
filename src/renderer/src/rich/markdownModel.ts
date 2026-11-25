import { Lexer, type Token, type Tokens } from 'marked'
import { detectArtifacts, parseArtifact, pathArtifact, type Artifact } from '../../../shared/artifacts'
import { LIVE_HTML_FENCE } from '../../../shared/richBlocks'

// A safe, structured view of Markdown. Every string here is rendered as text, never as markup:
// raw HTML in the source survives only as inert `raw-html` text.

export type ArtifactTextSegment = { type: 'text'; text: string } | { type: 'artifact'; text: string; artifact: Artifact }

export type RichInline =
  | ArtifactTextSegment
  | { type: 'strong' | 'emphasis' | 'strikethrough'; children: RichInline[] }
  | { type: 'code'; segments: ArtifactTextSegment[] }
  | { type: 'link'; href: string; title: string | null; artifact: Artifact | null; children: RichInline[] }
  | { type: 'image'; src: string; alt: string; title: string | null; artifact: Artifact | null }
  | { type: 'break' }
  | { type: 'raw-html'; text: string }

export type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'
export type CodePresentation = 'code' | 'mermaid' | 'html' | 'live-html'
export type ColumnAlign = 'left' | 'center' | 'right' | null

export type RichListItem = {
  // null when the item is not a task.
  checked: boolean | null
  children: RichBlock[]
}

export type RichBlock =
  | { type: 'heading'; depth: number; children: RichInline[] }
  | { type: 'paragraph'; children: RichInline[] }
  | { type: 'list'; ordered: boolean; start: number | null; loose: boolean; items: RichListItem[] }
  | { type: 'table'; align: ColumnAlign[]; header: RichInline[][]; rows: RichInline[][][] }
  | { type: 'blockquote'; callout: CalloutKind | null; children: RichBlock[] }
  | { type: 'code'; presentation: CodePresentation; language: string | null; title: string | null; text: string }
  | { type: 'rule' }
  | { type: 'raw-html'; text: string }

const CALLOUT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i
const LINE_BREAK_TAG = /^<br\s*\/?>$/i
const HTML_COMMENT = /^<!--[\s\S]*-->$/
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/

export function parseRichMarkdown(source: string): RichBlock[] {
  return mapBlocks(Lexer.lex(source, { gfm: true, breaks: false }))
}

function mapBlocks(tokens: Token[]): RichBlock[] {
  return tokens.flatMap((token) => mapBlock(token))
}

function mapBlock(token: Token): RichBlock[] {
  const typed = token as Tokens.Generic
  switch (typed.type) {
    case 'heading': {
      const heading = token as Tokens.Heading
      return [{ type: 'heading', depth: heading.depth, children: mapInlines(heading.tokens) }]
    }
    case 'paragraph':
      return [{ type: 'paragraph', children: mapInlines((token as Tokens.Paragraph).tokens) }]
    case 'text': {
      const text = token as Tokens.Text
      return [{ type: 'paragraph', children: text.tokens ? mapInlines(text.tokens) : textInlines(text.text) }]
    }
    case 'list':
      return [mapList(token as Tokens.List)]
    case 'table':
      return [mapTable(token as Tokens.Table)]
    case 'blockquote':
      return [mapBlockquote(token as Tokens.Blockquote)]
    case 'code':
      return [mapCode(token as Tokens.Code)]
    case 'hr':
      return [{ type: 'rule' }]
    case 'html': {
      const text = (token as Tokens.HTML).text.trimEnd()
      return HTML_COMMENT.test(text.trim()) ? [] : [{ type: 'raw-html', text }]
    }
    default:
      // space, def, checkbox and unknown extension tokens carry no content of their own.
      return typed.tokens ? mapBlocks(typed.tokens) : []
  }
}

function mapList(list: Tokens.List): RichBlock {
  return {
    type: 'list',
    ordered: list.ordered,
    start: list.ordered && typeof list.start === 'number' ? list.start : null,
    loose: list.loose,
    items: list.items.map((item) => ({
      checked: item.task ? Boolean(item.checked) : null,
      children: mapBlocks(item.tokens.filter((child) => child.type !== 'checkbox'))
    }))
  }
}

function mapTable(table: Tokens.Table): RichBlock {
  return {
    type: 'table',
    align: table.align,
    header: table.header.map((cell) => mapInlines(cell.tokens)),
    rows: table.rows.map((row) => row.map((cell) => mapInlines(cell.tokens)))
  }
}

function mapBlockquote(quote: Tokens.Blockquote): RichBlock {
  const [first, ...rest] = quote.tokens
  if (first?.type === 'paragraph') {
    const paragraph = first as Tokens.Paragraph
    const marker = CALLOUT_MARKER.exec(paragraph.text)
    if (marker) {
      const children = stripLeadingText(mergeText(paragraph.tokens), marker[0])
      const body: RichBlock[] = children.length > 0 ? [{ type: 'paragraph', children: mapInlines(children) }] : []
      return {
        type: 'blockquote',
        callout: marker[1].toLowerCase() as CalloutKind,
        children: [...body, ...mapBlocks(rest)]
      }
    }
  }
  return { type: 'blockquote', callout: null, children: mapBlocks(quote.tokens) }
}

function stripLeadingText(tokens: Token[], prefix: string): Token[] {
  const [first, ...rest] = tokens
  if (first?.type !== 'text' || !(first as Tokens.Text).text.startsWith(prefix)) return tokens
  const remaining = (first as Tokens.Text).text.slice(prefix.length)
  return remaining ? [{ ...first, text: remaining } as Tokens.Text, ...rest] : rest
}

function mapCode(code: Tokens.Code): RichBlock {
  const info = (code.lang ?? '').trim()
  const [word = '', ...titleWords] = info.split(/\s+/)
  const fence = word.toLowerCase()
  const title = titleWords.join(' ') || null
  const text = code.text

  if (fence === LIVE_HTML_FENCE) return { type: 'code', presentation: 'live-html', language: 'html', title, text }
  if (fence === 'mermaid') return { type: 'code', presentation: 'mermaid', language: 'mermaid', title, text }
  if (fence === 'html' || fence === 'htm') return { type: 'code', presentation: 'html', language: 'html', title, text }
  return { type: 'code', presentation: 'code', language: word || null, title, text }
}

function mapInlines(tokens: Token[]): RichInline[] {
  return compact(mergeText(tokens).flatMap((token) => mapInline(token, true)))
}

function mapLinkInlines(tokens: Token[]): RichInline[] {
  return compact(mergeText(tokens).flatMap((token) => mapInline(token, false)))
}

function mapInline(token: Token, detect: boolean): RichInline[] {
  const typed = token as Tokens.Generic
  switch (typed.type) {
    case 'text':
    case 'escape': {
      const text = decodeEntities((token as Tokens.Text).text)
      return detect ? textInlines(text) : [{ type: 'text', text }]
    }
    case 'strong':
    case 'em':
    case 'del': {
      const children = (token as Tokens.Strong).tokens
      const type = typed.type === 'strong' ? 'strong' : typed.type === 'em' ? 'emphasis' : 'strikethrough'
      return [{ type, children: detect ? mapInlines(children) : mapLinkInlines(children) }]
    }
    case 'codespan':
      return [{ type: 'code', segments: codeSegments((token as Tokens.Codespan).text, detect) }]
    case 'link': {
      const link = token as Tokens.Link
      return [
        {
          type: 'link',
          href: link.href,
          title: link.title ?? null,
          artifact: linkTargetArtifact(link.href),
          children: mapLinkInlines(link.tokens)
        }
      ]
    }
    case 'image': {
      const image = token as Tokens.Image
      return [
        {
          type: 'image',
          src: image.href,
          alt: decodeEntities(image.text),
          title: image.title ?? null,
          artifact: linkTargetArtifact(image.href)
        }
      ]
    }
    case 'br':
      return [{ type: 'break' }]
    case 'html': {
      const text = (token as Tokens.Tag).text
      if (LINE_BREAK_TAG.test(text.trim())) return [{ type: 'break' }]
      if (HTML_COMMENT.test(text.trim())) return []
      return [{ type: 'raw-html', text }]
    }
    default:
      return typed.tokens ? typed.tokens.flatMap((child) => mapInline(child, detect)) : []
  }
}

function textInlines(text: string): ArtifactTextSegment[] {
  return detectArtifacts(text).map((segment) =>
    segment.type === 'artifact'
      ? { type: 'artifact', text: segment.text, artifact: segment.artifact }
      : { type: 'text', text: segment.text }
  )
}

function codeSegments(text: string, detect: boolean): ArtifactTextSegment[] {
  if (!detect) return [{ type: 'text', text }]
  const whole = parseArtifact(text)
  if (whole && text === text.trim()) return [{ type: 'artifact', text, artifact: whole }]
  return textInlines(text)
}

// Links are explicit, so any non-URL target is treated as a path without the prose filter.
// In-page anchors and other schemes (mailto:, javascript:, ...) carry no artifact.
function linkTargetArtifact(href: string): Artifact | null {
  const target = href.trim()
  if (!target || target.startsWith('#')) return null
  if (/^https?:/i.test(target)) return parseArtifact(target)
  if (/^file:/i.test(target)) return parseArtifact(target)
  if (URI_SCHEME.test(target) && !/^[A-Za-z]:[\\/]/.test(target)) return null
  let decoded = target
  try {
    decoded = decodeURI(target)
  } catch {
    // Keep the target as written when it is not valid percent-encoding.
  }
  return pathArtifact(decoded)
}

function mergeText(tokens: Token[]): Token[] {
  const merged: Token[] = []
  for (const token of tokens) {
    const previous = merged.at(-1)
    if (token.type === 'text' && previous?.type === 'text' && !('tokens' in token && token.tokens)) {
      merged[merged.length - 1] = { ...previous, text: (previous as Tokens.Text).text + (token as Tokens.Text).text } as Tokens.Text
    } else {
      merged.push(token)
    }
  }
  return merged
}

function compact(inlines: RichInline[]): RichInline[] {
  const result: RichInline[] = []
  for (const inline of inlines) {
    const previous = result.at(-1)
    if (inline.type === 'text' && previous?.type === 'text') {
      result[result.length - 1] = { type: 'text', text: previous.text + inline.text }
    } else if (inline.type !== 'text' || inline.text) {
      result.push(inline)
    }
  }
  return result
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  times: '×',
  middot: '·',
  bull: '•'
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match
  })
}
