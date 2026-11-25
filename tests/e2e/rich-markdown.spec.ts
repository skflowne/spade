import { expect, test } from '@playwright/test'
import type { Artifact } from '../../src/shared/artifacts'
import { LIVE_HTML_FENCE, parseBridgeCall } from '../../src/shared/richBlocks'
import {
  parseRichMarkdown,
  type RichBlock,
  type RichInline
} from '../../src/renderer/src/rich/markdownModel'
import {
  buildAnswerDocument,
  parseRuntimeMessage,
  RUNTIME_MESSAGE_SOURCE
} from '../../src/renderer/src/rich/htmlRuntimeProtocol'

function only(source: string): RichBlock {
  const blocks = parseRichMarkdown(source)
  expect(blocks).toHaveLength(1)
  return blocks[0]
}

function inlines(source: string): RichInline[] {
  const block = only(source)
  if (block.type !== 'paragraph') throw new Error(`expected a paragraph, got ${block.type}`)
  return block.children
}

function path(value: string, line: number | null = null, isImage = false): Artifact {
  return { kind: 'path', value, line, column: null, isImage }
}

function url(value: string, isImage = false): Artifact {
  return { kind: 'url', value, line: null, column: null, isImage }
}

// Every string the model carries is rendered as text by React; this collects any value that could
// be mistaken for markup to be injected.
function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, into))
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, into))
  return into
}

test.describe('Markdown structure', () => {
  test('maps headings, emphasis, strikethrough, rules, and line breaks', () => {
    expect(parseRichMarkdown('## Plan **bold** *it* ~~old~~\n\n---\n\nline one  \nline two')).toEqual([
      {
        type: 'heading',
        depth: 2,
        children: [
          { type: 'text', text: 'Plan ' },
          { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
          { type: 'text', text: ' ' },
          { type: 'emphasis', children: [{ type: 'text', text: 'it' }] },
          { type: 'text', text: ' ' },
          { type: 'strikethrough', children: [{ type: 'text', text: 'old' }] }
        ]
      },
      { type: 'rule' },
      {
        type: 'paragraph',
        children: [{ type: 'text', text: 'line one' }, { type: 'break' }, { type: 'text', text: 'line two' }]
      }
    ])
  })

  test('maps ordered, unordered, and task lists', () => {
    expect(only('3. three\n4. four')).toEqual({
      type: 'list',
      ordered: true,
      start: 3,
      loose: false,
      items: [
        { checked: null, children: [{ type: 'paragraph', children: [{ type: 'text', text: 'three' }] }] },
        { checked: null, children: [{ type: 'paragraph', children: [{ type: 'text', text: 'four' }] }] }
      ]
    })

    expect(only('- [ ] todo\n- [x] done')).toEqual({
      type: 'list',
      ordered: false,
      start: null,
      loose: false,
      items: [
        { checked: false, children: [{ type: 'paragraph', children: [{ type: 'text', text: 'todo' }] }] },
        { checked: true, children: [{ type: 'paragraph', children: [{ type: 'text', text: 'done' }] }] }
      ]
    })
  })

  test('maps tables with column alignment', () => {
    expect(only('| a | b | c |\n|:-|:-:|-:|\n| 1 | 2 | 3 |')).toEqual({
      type: 'table',
      align: ['left', 'center', 'right'],
      header: [[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }], [{ type: 'text', text: 'c' }]],
      rows: [[[{ type: 'text', text: '1' }], [{ type: 'text', text: '2' }], [{ type: 'text', text: '3' }]]]
    })
  })

  test('maps blockquotes and GitHub-style callouts', () => {
    expect(only('> quoted')).toEqual({
      type: 'blockquote',
      callout: null,
      children: [{ type: 'paragraph', children: [{ type: 'text', text: 'quoted' }] }]
    })
    expect(only('> [!WARNING]\n> Mind the **gap**')).toEqual({
      type: 'blockquote',
      callout: 'warning',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', text: 'Mind the ' }, { type: 'strong', children: [{ type: 'text', text: 'gap' }] }]
        }
      ]
    })
  })

  test('decodes character references in text but not in code', () => {
    expect(inlines('a &amp; b &lt;c&gt; &#169; `&amp;`')).toEqual([
      { type: 'text', text: 'a & b <c> © ' },
      { type: 'code', segments: [{ type: 'text', text: '&amp;' }] }
    ])
  })
})

test.describe('raw HTML in Markdown', () => {
  test('is kept as inert text, never as markup', () => {
    const blocks = parseRichMarkdown(
      '<script>window.pwned = true</script>\n\n<div onclick="x()">block</div>\n\nHi <img src=x onerror="alert(1)"> <b>bold</b>'
    )

    expect(blocks).toEqual([
      { type: 'raw-html', text: '<script>window.pwned = true</script>' },
      { type: 'raw-html', text: '<div onclick="x()">block</div>' },
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'Hi ' },
          { type: 'raw-html', text: '<img src=x onerror="alert(1)">' },
          { type: 'text', text: ' ' },
          { type: 'raw-html', text: '<b>' },
          { type: 'text', text: 'bold' },
          { type: 'raw-html', text: '</b>' }
        ]
      }
    ])
  })

  test('turns <br> into a line break and drops HTML comments', () => {
    expect(inlines('a<br>b<br/>c <!-- hidden -->')).toEqual([
      { type: 'text', text: 'a' },
      { type: 'break' },
      { type: 'text', text: 'b' },
      { type: 'break' },
      { type: 'text', text: 'c ' }
    ])
    expect(parseRichMarkdown('<!-- note -->\n\ntext')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: 'text' }] }
    ])
  })

  test('marks a link with a script URL as having no artifact', () => {
    const [link] = inlines('[x](javascript:alert(1))')
    expect(link).toMatchObject({ type: 'link', artifact: null })
    expect(collectStrings(parseRichMarkdown('[x](javascript:alert(1))'))).not.toContain('<script>')
  })
})

test.describe('fenced code conventions', () => {
  test('selects a presentation from the first word of the info string', () => {
    const blocks = parseRichMarkdown(
      [
        '```ts',
        'const a = 1',
        '```',
        '```',
        'plain',
        '```',
        '```mermaid',
        'flowchart LR; A-->B',
        '```',
        '```html',
        '<p>shown as code</p>',
        '```',
        `\`\`\`${LIVE_HTML_FENCE} Plan review`,
        '<!doctype html><p>live</p>',
        '```'
      ].join('\n')
    )

    expect(blocks).toEqual([
      { type: 'code', presentation: 'code', language: 'ts', title: null, text: 'const a = 1' },
      { type: 'code', presentation: 'code', language: null, title: null, text: 'plain' },
      { type: 'code', presentation: 'mermaid', language: 'mermaid', title: null, text: 'flowchart LR; A-->B' },
      { type: 'code', presentation: 'html', language: 'html', title: null, text: '<p>shown as code</p>' },
      {
        type: 'code',
        presentation: 'live-html',
        language: 'html',
        title: 'Plan review',
        text: '<!doctype html><p>live</p>'
      }
    ])
  })

  test('uses spade-html as the live HTML fence word', () => {
    expect(LIVE_HTML_FENCE).toBe('spade-html')
    expect(only('```SPADE-HTML\n<p>x</p>\n```')).toMatchObject({ presentation: 'live-html', title: null })
  })
})

test.describe('inline artifacts', () => {
  test('are extracted from text', () => {
    expect(inlines('Edit src/main/index.ts:3 and see https://example.com/a.')).toEqual([
      { type: 'text', text: 'Edit ' },
      { type: 'artifact', text: 'src/main/index.ts:3', artifact: path('src/main/index.ts', 3) },
      { type: 'text', text: ' and see ' },
      { type: 'link', href: 'https://example.com/a', title: null, artifact: url('https://example.com/a'), children: [{ type: 'text', text: 'https://example.com/a' }] },
      { type: 'text', text: '.' }
    ])
  })

  test('make a whole code span one artifact, even with spaces', () => {
    expect(inlines('`docs/my notes/a.md`')).toEqual([
      { type: 'code', segments: [{ type: 'artifact', text: 'docs/my notes/a.md', artifact: path('docs/my notes/a.md') }] }
    ])
  })

  test('are found inside code spans that hold commands', () => {
    expect(inlines('`node ./scripts/run.mjs --fast`')).toEqual([
      {
        type: 'code',
        segments: [
          { type: 'text', text: 'node ' },
          { type: 'artifact', text: './scripts/run.mjs', artifact: path('./scripts/run.mjs') },
          { type: 'text', text: ' --fast' }
        ]
      }
    ])
  })

  test('come from Markdown links, which never nest further artifacts', () => {
    expect(inlines('[plan](docs/plan.html "Plan") [dir](docs/My%20Notes) [top](#intro) [mail](mailto:a@b.c)')).toEqual([
      { type: 'link', href: 'docs/plan.html', title: 'Plan', artifact: path('docs/plan.html'), children: [{ type: 'text', text: 'plan' }] },
      { type: 'text', text: ' ' },
      { type: 'link', href: 'docs/My%20Notes', title: null, artifact: path('docs/My Notes'), children: [{ type: 'text', text: 'dir' }] },
      { type: 'text', text: ' ' },
      { type: 'link', href: '#intro', title: null, artifact: null, children: [{ type: 'text', text: 'top' }] },
      { type: 'text', text: ' ' },
      { type: 'link', href: 'mailto:a@b.c', title: null, artifact: null, children: [{ type: 'text', text: 'mail' }] }
    ])
    expect(inlines('[see src/a.ts](https://example.com)')[0]).toMatchObject({
      children: [{ type: 'text', text: 'see src/a.ts' }]
    })
  })

  test('come from Markdown images, as image artifacts', () => {
    expect(inlines('![shot](./out/shot.png) ![remote](https://example.com/a.webp "t") ![inline](data:image/png;base64,AAAA)')).toEqual([
      { type: 'image', src: './out/shot.png', alt: 'shot', title: null, artifact: path('./out/shot.png', null, true) },
      { type: 'text', text: ' ' },
      { type: 'image', src: 'https://example.com/a.webp', alt: 'remote', title: 't', artifact: url('https://example.com/a.webp', true) },
      { type: 'text', text: ' ' },
      { type: 'image', src: 'data:image/png;base64,AAAA', alt: 'inline', title: null, artifact: null }
    ])
  })
})

test.describe('interactive answer bridge', () => {
  test('accepts well-formed submit and annotate calls', () => {
    expect(parseBridgeCall('submit', { message: 'go' })).toEqual({ method: 'submit', input: { message: 'go' } })
    expect(parseBridgeCall('submit', { data: { choice: 2 } })).toEqual({ method: 'submit', input: { data: { choice: 2 } } })
    expect(parseBridgeCall('annotate', { target: 'step-1', text: 'Too risky', data: [1] })).toEqual({
      method: 'annotate',
      input: { target: 'step-1', text: 'Too risky', data: [1] }
    })
  })

  test('rejects malformed calls whole', () => {
    expect(parseBridgeCall('submit', {})).toBeNull()
    expect(parseBridgeCall('submit', { message: 3 })).toBeNull()
    expect(parseBridgeCall('submit', { message: 'x', extra: true })).toBeNull()
    expect(parseBridgeCall('annotate', { target: 'x' })).toBeNull()
    expect(parseBridgeCall('annotate', { text: 'x', target: 1 })).toBeNull()
    expect(parseBridgeCall('navigate', { message: 'x' })).toBeNull()
    expect(parseBridgeCall('submit', ['x'])).toBeNull()
    expect(parseBridgeCall('submit', null)).toBeNull()
  })
})

test.describe('HTML answer runtime protocol', () => {
  test('injects the bridge prelude after the doctype, before agent content', () => {
    const document = buildAnswerDocument('<!DOCTYPE html>\n<html><head><style>p{}</style></head><body><p>x</p></body></html>', {
      token: 'token-1',
      themeCss: ':root{--accent:#6ea8fe}'
    })

    expect(document.startsWith('<!DOCTYPE html>')).toBe(true)
    const prelude = document.indexOf('<script>')
    expect(prelude).toBeGreaterThan(0)
    expect(prelude).toBeLessThan(document.indexOf('<html>'))
    expect(document).toContain('"token-1"')
    expect(document).toContain(':root{--accent:#6ea8fe}')
    expect(document.indexOf(':root{--accent:#6ea8fe}')).toBeLessThan(document.indexOf('<style>p{}'))
  })

  test('adds a doctype to fragments so they render in standards mode', () => {
    const document = buildAnswerDocument('<p>fragment</p>', { token: 't', themeCss: '' })
    expect(document.startsWith('<!doctype html>')).toBe(true)
    expect(document.endsWith('<p>fragment</p>')).toBe(true)
  })

  test('keeps theme CSS from closing its style element', () => {
    const document = buildAnswerDocument('<p>x</p>', { token: 't', themeCss: ':root{--font:"a</style><script>"}' })
    expect(document.split('</style>')).toHaveLength(2)
    expect(document.split('<script>')).toHaveLength(2)
  })

  test('accepts only runtime messages carrying the current token', () => {
    const base = { source: RUNTIME_MESSAGE_SOURCE, token: 'current' }

    expect(parseRuntimeMessage({ ...base, type: 'ready' }, 'current')).toEqual({ type: 'ready' })
    expect(parseRuntimeMessage({ ...base, type: 'resize', height: 321.4 }, 'current')).toEqual({ type: 'resize', height: 322 })
    expect(parseRuntimeMessage({ ...base, type: 'open-url', url: 'https://example.com' }, 'current')).toEqual({
      type: 'open-url',
      url: 'https://example.com'
    })
    expect(parseRuntimeMessage({ ...base, type: 'call', id: 4, method: 'submit', input: { message: 'x' } }, 'current')).toEqual({
      type: 'call',
      id: 4,
      method: 'submit',
      input: { message: 'x' }
    })

    expect(parseRuntimeMessage({ ...base, type: 'escape' }, 'current')).toEqual({ type: 'escape' })

    expect(parseRuntimeMessage({ ...base, type: 'escape' }, 'other')).toBeNull()
    expect(parseRuntimeMessage({ ...base, type: 'ready' }, 'other')).toBeNull()
    expect(parseRuntimeMessage({ ...base, source: 'elsewhere', type: 'ready' }, 'current')).toBeNull()
    expect(parseRuntimeMessage({ ...base, type: 'resize', height: Number.NaN }, 'current')).toBeNull()
    expect(parseRuntimeMessage({ ...base, type: 'call', id: 'x', method: 'submit', input: {} }, 'current')).toBeNull()
    expect(parseRuntimeMessage({ ...base, type: 'open-url', url: 'javascript:alert(1)' }, 'current')).toBeNull()
    expect(parseRuntimeMessage('ready', 'current')).toBeNull()
  })
})
