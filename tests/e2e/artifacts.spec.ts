import { expect, test } from '@playwright/test'
import { detectArtifacts, parseArtifact, type Artifact } from '../../src/shared/artifacts'

type Found = { text: string } & Artifact

function found(text: string): Found[] {
  return detectArtifacts(text).flatMap((segment) =>
    segment.type === 'artifact' ? [{ text: segment.text, ...segment.artifact }] : []
  )
}

function foundTexts(text: string): string[] {
  return found(text).map((artifact) => artifact.text)
}

function url(value: string, isImage = false): Artifact {
  return { kind: 'url', value, line: null, column: null, isImage }
}

function path(value: string, line: number | null = null, column: number | null = null, isImage = false): Artifact {
  return { kind: 'path', value, line, column, isImage }
}

test.describe('artifact segments', () => {
  test('cover the input exactly, in order, with source ranges', () => {
    const input = 'See https://example.com/a and src/main/index.ts:12 now.'
    const segments = detectArtifacts(input)

    expect(segments.map((segment) => segment.text).join('')).toBe(input)
    for (const segment of segments) {
      expect(input.slice(segment.start, segment.end)).toBe(segment.text)
    }
    expect(segments.map((segment) => segment.type)).toEqual(['text', 'artifact', 'text', 'artifact', 'text'])
  })

  test('return one text segment for text without artifacts and nothing for empty text', () => {
    expect(detectArtifacts('just words')).toEqual([
      { type: 'text', text: 'just words', start: 0, end: 10 }
    ])
    expect(detectArtifacts('')).toEqual([])
  })
})

test.describe('URL detection', () => {
  test('finds http and https links', () => {
    expect(found('open http://localhost:5173/x?y=1#z or https://github.com/a/b')).toEqual([
      { text: 'http://localhost:5173/x?y=1#z', ...url('http://localhost:5173/x?y=1#z') },
      { text: 'https://github.com/a/b', ...url('https://github.com/a/b') }
    ])
  })

  test('trims trailing sentence punctuation and quotes', () => {
    expect(foundTexts('Go to https://example.com/page.')).toEqual(['https://example.com/page'])
    expect(foundTexts('https://example.com/a, https://example.com/b; https://example.com/c!')).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c'
    ])
    expect(foundTexts('"https://example.com/q"')).toEqual(['https://example.com/q'])
    expect(foundTexts('is it https://example.com/q?')).toEqual(['https://example.com/q'])
  })

  test('keeps balanced parentheses and drops unbalanced closing ones', () => {
    expect(foundTexts('(see https://en.wikipedia.org/wiki/Rust_(language))')).toEqual([
      'https://en.wikipedia.org/wiki/Rust_(language)'
    ])
    expect(foundTexts('(https://example.com/x)')).toEqual(['https://example.com/x'])
    expect(foundTexts('[https://example.com/x]')).toEqual(['https://example.com/x'])
  })

  test('ignores schemes without a host and words that merely contain http', () => {
    expect(found('http:// and https:/// and xhttp://example.com')).toEqual([])
  })

  test('flags image URLs by their path extension, ignoring query and fragment', () => {
    expect(found('https://example.com/shot.PNG?raw=1')).toEqual([
      { text: 'https://example.com/shot.PNG?raw=1', ...url('https://example.com/shot.PNG?raw=1', true) }
    ])
    expect(found('https://example.com/png')[0].isImage).toBe(false)
  })

  test('never reports paths inside a URL', () => {
    expect(found('https://github.com/org/repo/blob/main/src/main/index.ts:12')).toEqual([
      {
        text: 'https://github.com/org/repo/blob/main/src/main/index.ts:12',
        ...url('https://github.com/org/repo/blob/main/src/main/index.ts:12')
      }
    ])
  })
})

test.describe('absolute path detection', () => {
  test('finds Windows drive paths with either separator', () => {
    expect(found('Edit C:\\Users\\me\\spade\\src\\main\\index.ts now')).toEqual([
      { text: 'C:\\Users\\me\\spade\\src\\main\\index.ts', ...path('C:\\Users\\me\\spade\\src\\main\\index.ts') }
    ])
    expect(foundTexts('wrote d:/work/out/report.json.')).toEqual(['d:/work/out/report.json'])
  })

  test('finds UNC paths', () => {
    expect(found('share at \\\\server\\share\\docs\\plan.md')).toEqual([
      { text: '\\\\server\\share\\docs\\plan.md', ...path('\\\\server\\share\\docs\\plan.md') }
    ])
  })

  test('finds POSIX absolute paths', () => {
    expect(foundTexts('see /home/dev/spade/src/main/index.ts and /etc/hosts')).toEqual([
      '/home/dev/spade/src/main/index.ts',
      '/etc/hosts'
    ])
    expect(foundTexts('read /notes.txt')).toEqual(['/notes.txt'])
  })

  test('splits line and column suffixes from the path', () => {
    expect(found('C:\\repo\\src\\app.ts:42:7')).toEqual([
      { text: 'C:\\repo\\src\\app.ts:42:7', ...path('C:\\repo\\src\\app.ts', 42, 7) }
    ])
    expect(found('/repo/src/app.ts:42')).toEqual([{ text: '/repo/src/app.ts:42', ...path('/repo/src/app.ts', 42) }])
    expect(found('/repo/src/app.ts:42-60')).toEqual([
      { text: '/repo/src/app.ts:42-60', ...path('/repo/src/app.ts', 42) }
    ])
  })

  test('reads file URLs as paths', () => {
    expect(found('file:///C:/repo/a.png')).toEqual([{ text: 'file:///C:/repo/a.png', ...path('C:/repo/a.png', null, null, true) }])
    expect(found('file:///home/dev/a.txt')).toEqual([{ text: 'file:///home/dev/a.txt', ...path('/home/dev/a.txt') }])
  })

  test('ignores lone roots, comment markers, and single extensionless segments', () => {
    expect(found('a / b // comment /tmp /2 and /s')).toEqual([])
  })
})

test.describe('relative path detection', () => {
  test('finds project-relative files with a separator and an extension', () => {
    expect(foundTexts('Changed src/main/index.ts and docs/plan.html.')).toEqual([
      'src/main/index.ts',
      'docs/plan.html'
    ])
    expect(found('src/renderer/src/App.tsx:10:3')).toEqual([
      { text: 'src/renderer/src/App.tsx:10:3', ...path('src/renderer/src/App.tsx', 10, 3) }
    ])
  })

  test('finds dot-prefixed paths with either separator', () => {
    expect(foundTexts('run ./scripts/build and open ./docs/plan.html or ..\\x\\y.png')).toEqual([
      './scripts/build',
      './docs/plan.html',
      '..\\x\\y.png'
    ])
    expect(found('..\\x\\y.png')[0].isImage).toBe(true)
  })

  test('finds directories written with a trailing separator', () => {
    expect(foundTexts('look in src/main/ and tests/')).toEqual(['src/main/', 'tests/'])
  })

  test('finds dotfiles and scoped package paths', () => {
    expect(foundTexts('see config/.env and node_modules/@xyflow/react/dist/style.css')).toEqual([
      'config/.env',
      'node_modules/@xyflow/react/dist/style.css'
    ])
  })

  test('strips surrounding brackets and punctuation', () => {
    expect(foundTexts('(src/a.ts), [src/b.ts]; "src/c.ts" `src/d.ts`: src/e.ts:')).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/d.ts',
      'src/e.ts'
    ])
  })

  test('flags image paths', () => {
    expect(found('assets/logo.svg assets/shot.JPEG assets/a.gif assets/b.webp assets/c.jpg').map((a) => a.isImage)).toEqual([
      true,
      true,
      true,
      true,
      true
    ])
    expect(found('assets/doc.pdf')[0].isImage).toBe(false)
  })

  test('does not match ordinary prose', () => {
    const prose = [
      'and/or',
      'either/or.',
      '1/2 of the time',
      'TCP/IP',
      'input/output',
      'w/ and w/o',
      'on 2024/01/02 or 01/02/2024',
      'version 1.2.3/4.5.6',
      'v1.2/v1.3',
      'e.g./i.e.',
      'km/h',
      'Yes/No?',
      '50/50.',
      'github.com/org/repo.git',
      'README.md',
      'just a sentence.'
    ]
    for (const text of prose) {
      expect(found(text), text).toEqual([])
    }
  })

  test('only matches paths with spaces when quoted or backticked', () => {
    expect(foundTexts('open My Documents/plan.md')).not.toContain('My Documents/plan.md')
    expect(found('open "My Documents/plan v2.md" now')).toEqual([
      { text: 'My Documents/plan v2.md', ...path('My Documents/plan v2.md') }
    ])
    expect(foundTexts("open 'C:\\Program Files (x86)\\app\\shot one.png' now")).toEqual([
      'C:\\Program Files (x86)\\app\\shot one.png'
    ])
    expect(foundTexts('open `docs/my notes/a.md:3`')).toEqual(['docs/my notes/a.md:3'])
  })

  test('does not mistake apostrophes for quotes around paths', () => {
    expect(foundTexts("don't touch 'src/a b.ts', it's fine")).toEqual(['src/a b.ts'])
    expect(foundTexts("it's src/a.ts that's wrong")).toEqual(['src/a.ts'])
  })
})

test.describe('whole-string artifact parsing', () => {
  test('classifies a URL, a path with spaces, or nothing', () => {
    expect(parseArtifact('https://example.com/a.png')).toEqual(url('https://example.com/a.png', true))
    expect(parseArtifact('docs/my notes/a.md:3')).toEqual(path('docs/my notes/a.md', 3))
    expect(parseArtifact('  src/a.ts  ')).toEqual(path('src/a.ts'))
    expect(parseArtifact('npm run build')).toBeNull()
    expect(parseArtifact('and/or')).toBeNull()
    expect(parseArtifact('')).toBeNull()
  })
})
