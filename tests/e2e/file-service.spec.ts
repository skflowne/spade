import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { FileService } from '../../src/main/contracts'
import { FileServiceError } from '../../src/main/files/errors'
import { createFileService, type FileServiceOptions } from '../../src/main/files/fileService'
import type { FileServiceHost } from '../../src/main/files/host'
import { readImageDimensions, sniffImageType } from '../../src/main/files/imageFormat'
import {
  IMAGE_PROTOCOL_SCHEME,
  buildImageUrl,
  createImageRequestHandler,
  parseImageUrl
} from '../../src/main/files/imageProtocol'
import { nodeFileSystem, type FileSystemReads } from '../../src/main/files/fileSystem'
import { fitImageNodeSize } from '../../src/main/files/imageSizing'
import { installWebviewPolicy, type WebviewPolicyTarget } from '../../src/main/files/webviewPolicy'
import { AssetStore } from '../../src/main/persistence'
import { IMAGE_EXTENSIONS } from '../../src/shared/paths'
import { WEB_PAGE_PARTITION } from '../../src/shared/builtinEntities'
import type { Project } from '../../src/shared/domain'

// ---------- Image fixtures, encoded from their dimensions independently of the parser ----------

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0))
const u16be = (n: number) => [(n >> 8) & 255, n & 255]
const u16le = (n: number) => [n & 255, (n >> 8) & 255]
const u24le = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255]
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const u32le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]
const bytes = (...parts: number[][]) => new Uint8Array(parts.flat())
const text = (value: string) => new TextEncoder().encode(value)

function png(width: number, height: number): Uint8Array {
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    u32be(13),
    ascii('IHDR'),
    u32be(width),
    u32be(height),
    [8, 6, 0, 0, 0],
    u32be(0)
  )
}

function gif(width: number, height: number): Uint8Array {
  return bytes(ascii('GIF89a'), u16le(width), u16le(height), [0, 0, 0])
}

function jpeg(width: number, height: number, options: { orientation?: number; sof?: number; littleEndianExif?: boolean } = {}) {
  const segment = (marker: number, payload: number[]) => [0xff, marker, ...u16be(payload.length + 2), ...payload]
  const exif = (orientation: number) => {
    const le = options.littleEndianExif === true
    const w16 = le ? u16le : u16be
    const w32 = le ? u32le : u32be
    return [
      ...ascii('Exif\0\0'),
      ...(le ? ascii('II') : ascii('MM')),
      ...w16(42),
      ...w32(8),
      ...w16(1),
      ...w16(0x0112),
      ...w16(3),
      ...w32(1),
      ...w16(orientation),
      0,
      0,
      ...w32(0)
    ]
  }
  return bytes(
    [0xff, 0xd8],
    segment(0xe0, [...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    options.orientation === undefined ? [] : segment(0xe1, exif(options.orientation)),
    segment(0xdb, [0, ...new Array(64).fill(1)]),
    segment(0xc4, [0, ...new Array(16).fill(0)]),
    // Fill bytes before a marker are legal.
    [0xff],
    segment(options.sof ?? 0xc0, [8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]),
    [0x12, 0x34, 0xff, 0xd9]
  )
}

function riff(chunk: string, payload: number[]): Uint8Array {
  return bytes(ascii('RIFF'), u32le(4 + 8 + payload.length), ascii('WEBP'), ascii(chunk), u32le(payload.length), payload)
}

const webpLossy = (width: number, height: number) =>
  riff('VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height), 0, 0])
const webpLossless = (width: number, height: number) =>
  riff('VP8L', [0x2f, ...u32le(((width - 1) | ((height - 1) << 14)) >>> 0), 0])
const webpExtended = (width: number, height: number) =>
  riff('VP8X', [0x10, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)])

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"'

// ---------- Service fixtures ----------

type FakeHost = FileServiceHost & {
  shown: string[]
  opened: string[]
  external: string[]
  clipboard: string[]
  dialogs: Array<{ defaultPath: string; extensions: readonly string[] }>
  dialogResult: string | null
  openPathResult: string
  imageHandler: ((request: Request) => Promise<Response>) | null
  webviews: FakeWebviews
}

class FakeEvent {
  defaultPrevented = false
  constructor(readonly url = '') {}
  preventDefault(): void {
    this.defaultPrevented = true
  }
}

class FakeContents extends EventEmitter {
  windowOpenHandler: ((details: { url: string }) => { action: 'deny' }) | null = null
  readonly loaded: string[] = []
  constructor(private readonly type: string) {
    super()
  }
  getType(): string {
    return this.type
  }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void {
    this.windowOpenHandler = handler
  }
  async loadURL(url: string): Promise<void> {
    this.loaded.push(url)
  }
}

class FakeSession extends EventEmitter {
  requestHandler: ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null = null
  checkHandler: ((contents: unknown, permission: string) => boolean) | null = null
  setPermissionRequestHandler(handler: FakeSession['requestHandler']): void {
    this.requestHandler = handler
  }
  setPermissionCheckHandler(handler: FakeSession['checkHandler']): void {
    this.checkHandler = handler
  }
  requestPermission(permission: string): boolean {
    let granted: boolean | null = null
    this.requestHandler?.(null, permission, (value) => (granted = value))
    if (granted === null) throw new Error(`no decision for ${permission}`)
    return granted
  }
}

type FakeWebviews = { target: WebviewPolicyTarget; session: FakeSession; create(type: string): FakeContents; listeners(): number }

function createFakeWebviews(): FakeWebviews {
  const app = new EventEmitter()
  const session = new FakeSession()
  return {
    session,
    target: {
      onWebContentsCreated(listener) {
        app.on('created', listener)
        return () => app.off('created', listener)
      },
      session
    },
    create(type) {
      const contents = new FakeContents(type)
      app.emit('created', contents)
      return contents
    },
    listeners: () => app.listenerCount('created')
  }
}

function createFakeHost(): FakeHost {
  const host: FakeHost = {
    shown: [],
    opened: [],
    external: [],
    clipboard: [],
    dialogs: [],
    dialogResult: null,
    openPathResult: '',
    imageHandler: null,
    webviews: createFakeWebviews(),
    showItemInFolder: (path) => void host.shown.push(path),
    openPath: async (path) => {
      host.opened.push(path)
      return host.openPathResult
    },
    openExternal: async (url) => void host.external.push(url),
    writeClipboardText: (value) => void host.clipboard.push(value),
    showOpenImageDialog: async (options) => {
      host.dialogs.push(options)
      return host.dialogResult
    },
    handleImageProtocol(handler) {
      host.imageHandler = handler
      return () => (host.imageHandler = null)
    },
    guestWebviews: () => host.webviews.target
  }
  return host
}

type Fixture = { root: string; appData: string; project: Project; host: FakeHost; assets: AssetStore; service: FileService }

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
  options: Partial<Omit<FileServiceOptions, 'host' | 'assetStore'>> = {}
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'spade-files-'))
  const root = join(directory, 'project')
  const appData = join(directory, 'app-data')
  await mkdir(root)
  await mkdir(appData)
  const project: Project = { version: 2, id: 'project-1', name: 'Demo', rootPath: root, createdAt: '2026-01-01T00:00:00.000Z' }
  const host = createFakeHost()
  const assets = new AssetStore({ directory: appData })
  const service = createFileService({ host, assetStore: assets, ...options })
  try {
    await run({ root, appData, project, host, assets, service })
  } finally {
    await service.stop()
    await rm(directory, { recursive: true, force: true })
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(FileServiceError)
    return (error as FileServiceError).code
  }
  throw new Error('expected a rejection')
}

async function snapshotTree(directory: string): Promise<string[]> {
  const entries = (await readdir(directory, { recursive: true })).sort()
  const rootStat = await stat(directory)
  const lines = [`.:${rootStat.mtimeMs}`]
  for (const entry of entries) {
    const info = await stat(join(directory, entry))
    lines.push(`${entry}:${info.isDirectory() ? 'dir' : info.size}:${info.mtimeMs}`)
  }
  return lines
}

const userActor = { kind: 'user' } as const

// ---------- Path inspection ----------

test('path inspection resolves relative paths against the project root and reports files, directories, and images', async () => {
  await withFixture(async ({ root, project, service }) => {
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'main.ts'), 'x')
    await writeFile(join(root, 'shot.PNG'), png(2, 2))

    expect(await service.inspectPath(project, 'src/main.ts')).toEqual({
      input: 'src/main.ts',
      absolutePath: join(root, 'src', 'main.ts'),
      kind: 'file',
      isImage: false,
      line: null
    })
    expect(await service.inspectPath(project, 'src')).toMatchObject({ kind: 'directory', isImage: false })
    expect(await service.inspectPath(project, join(root, 'shot.PNG'))).toMatchObject({
      absolutePath: join(root, 'shot.PNG'),
      kind: 'file',
      isImage: true
    })
  })
})

test('path inspection splits line and column suffixes before checking existence', async () => {
  await withFixture(async ({ root, project, service }) => {
    await writeFile(join(root, 'app.ts'), 'x')

    expect(await service.inspectPath(project, 'app.ts:42')).toEqual({
      input: 'app.ts:42',
      absolutePath: join(root, 'app.ts'),
      kind: 'file',
      isImage: false,
      line: 42
    })
    expect(await service.inspectPath(project, `${join(root, 'app.ts')}:7:3`)).toMatchObject({ kind: 'file', line: 7 })
  })
})

test('path inspection reports missing, unreadable, and malformed paths as missing instead of failing', async () => {
  await withFixture(async ({ project, service }) => {
    for (const input of ['nope.ts', 'nope.png:3', '', 'bad\0name', 'C:\\does\\not\\exist.png']) {
      const info = await service.inspectPath(project, input)
      expect(info.kind, JSON.stringify(input)).toBe('missing')
      expect(info.input).toBe(input)
    }
    expect((await service.inspectPath(project, 'nope.png')).isImage).toBe(false)
  })
})

// ---------- Network paths ----------

// Records every filesystem call the service makes, then performs it for real.
function spyFileSystem(): { fileSystem: FileSystemReads; touched: string[] } {
  const touched: string[] = []
  return {
    touched,
    fileSystem: {
      stat: (path) => (touched.push(path), nodeFileSystem.stat(path)),
      openImage: (path, prefixBytes) => (touched.push(path), nodeFileSystem.openImage(path, prefixBytes)),
      watchFile: (path, options, listener) => (touched.push(path), nodeFileSystem.watchFile(path, options, listener)),
      unwatchFile: (path, listener) => nodeFileSystem.unwatchFile(path, listener)
    }
  }
}

test('a network path outside the project is never touched unless the user acts on it explicitly', async () => {
  const { fileSystem, touched } = spyFileSystem()
  await withFixture(
    async ({ project, host, service }) => {
      await service.start()
      const share = '\\\\attacker.example\\share'
      const paths = [`${share}\\loot.png`, '\\\\?\\UNC\\attacker.example\\share\\x.png', '//attacker.example/share/y.png:12']

      for (const input of paths) {
        const info = await service.inspectPath(project, input)
        expect(info, input).toMatchObject({ input, kind: 'unchecked', isImage: false })
        expect(await codeOf(service.describeImage(project, { kind: 'path', path: input.replace(/:12$/, '') })), input).toBe('network-path')
      }
      expect((await service.inspectPath(project, `${share}\\a.png:7`)).line).toBe(7)

      const created = await service.imageEntityAdapter.create({
        nodeId: 'n',
        project,
        sourceNode: null,
        actor: userActor,
        config: { source: { kind: 'path', path: `${share}\\loot.png` } }
      })
      expect(created).toEqual({ resourceRef: null, title: 'loot.png', config: { source: { kind: 'path', path: `${share}\\loot.png` } } })

      const served = await host.imageHandler!(new Request(buildImageUrl({ kind: 'file', path: `${share}\\loot.png` }, 'x')))
      expect(served.status).toBe(403)
      expect(touched).toEqual([])

      // An explicit request touches that path, and from then on it is approved for this session.
      expect(await service.inspectPath(project, `${share}\\loot.png`, { explicit: true })).toMatchObject({ kind: 'missing' })
      expect(touched).toEqual([`${share}\\loot.png`])
      expect((await service.inspectPath(project, '//ATTACKER.example/share/loot.png')).kind).toBe('missing')
      expect(await codeOf(service.describeImage(project, { kind: 'path', path: `${share}\\loot.png` }))).toBe('image-missing')
      expect((await host.imageHandler!(new Request(buildImageUrl({ kind: 'file', path: `${share}\\loot.png` }, 'x')))).status).toBe(404)
      // Approval covers that path only.
      touched.length = 0
      expect((await service.inspectPath(project, `${share}\\other.png`)).kind).toBe('unchecked')
      expect(touched).toEqual([])

      // An explicit image description approves and watches it.
      expect(await codeOf(service.describeImage(project, { kind: 'path', path: `${share}\\other.png` }, { explicit: true }))).toBe('image-missing')
      expect(touched).toEqual([`${share}\\other.png`, `${share}\\other.png`])
    },
    { fileSystem }
  )
})

test('revealing a network path is an explicit request', async () => {
  const { fileSystem, touched } = spyFileSystem()
  await withFixture(
    async ({ project, service }) => {
      expect(await codeOf(service.reveal(project, '\\\\host\\share\\x.txt'))).toBe('path-missing')
      expect(touched).toEqual(['\\\\host\\share\\x.txt'])
      expect((await service.inspectPath(project, '\\\\host\\share\\x.txt')).kind).toBe('missing')
    },
    { fileSystem }
  )
})

test('paths inside a project whose root is a network share are always checked', async () => {
  const { fileSystem, touched } = spyFileSystem()
  await withFixture(
    async ({ service }) => {
      await service.start()
      const project: Project = {
        version: 2,
        id: 'project-unc',
        name: 'Shared',
        rootPath: '\\\\fileserver\\team\\framework',
        createdAt: '2026-01-01T00:00:00.000Z'
      }
      expect((await service.inspectPath(project, 'src\\a.ts')).kind).toBe('missing')
      expect((await service.inspectPath(project, '\\\\fileserver\\team\\framework')).kind).not.toBe('unchecked')
      expect(await codeOf(service.describeImage(project, { kind: 'path', path: 'shots\\a.png' }))).toBe('image-missing')
      await service.imageEntityAdapter.create({
        nodeId: 'n',
        project,
        sourceNode: null,
        actor: userActor,
        config: { source: { kind: 'path', path: 'shots\\b.png' } }
      })
      expect(touched).toEqual([
        '\\\\fileserver\\team\\framework\\src\\a.ts',
        '\\\\fileserver\\team\\framework',
        '\\\\fileserver\\team\\framework\\shots\\a.png',
        '\\\\fileserver\\team\\framework\\shots\\a.png',
        '\\\\fileserver\\team\\framework\\shots\\b.png'
      ])

      // `..` out of the root, or a sibling share, is outside it.
      touched.length = 0
      expect((await service.inspectPath(project, '..\\secrets\\x.txt')).kind).toBe('unchecked')
      expect((await service.inspectPath(project, '\\\\fileserver\\other\\x.txt')).kind).toBe('unchecked')
      expect(touched).toEqual([])
    },
    { fileSystem }
  )
})

test('the image protocol refuses network paths by default', async () => {
  const handle = createImageRequestHandler({ resolveAsset: async () => null })
  for (const path of ['\\\\host\\share\\a.png', '\\\\?\\UNC\\host\\share\\a.png']) {
    expect((await handle(new Request(buildImageUrl({ kind: 'file', path }, 'x')))).status, path).toBe(403)
  }
})

// ---------- Reveal ----------

test('revealing a file only selects it in Explorer, whatever its extension, and never opens it', async () => {
  await withFixture(async ({ root, project, host, service }) => {
    const names = ['setup.exe', 'install.bat', 'shortcut.lnk', 'run.cmd', 'script.ps1', 'notes.txt', 'noextension']
    for (const name of names) await writeFile(join(root, name), 'MZ')

    for (const name of names) await service.reveal(project, name)
    await service.reveal(project, 'run.cmd:12')

    expect(host.shown).toEqual([...names.map((name) => join(root, name)), join(root, 'run.cmd')])
    expect(host.opened).toEqual([])
  })
})

test('revealing a directory opens it in Explorer, even when its name looks executable', async () => {
  await withFixture(async ({ root, project, host, service }) => {
    await mkdir(join(root, 'tools.exe'))
    await mkdir(join(root, 'docs'))

    await service.reveal(project, 'tools.exe')
    await service.reveal(project, join(root, 'docs'))

    expect(host.opened).toEqual([join(root, 'tools.exe'), join(root, 'docs')])
    expect(host.shown).toEqual([])
  })
})

test('revealing a missing path rejects without touching the shell', async () => {
  await withFixture(async ({ project, host, service }) => {
    expect(await codeOf(service.reveal(project, 'gone.exe'))).toBe('path-missing')
    expect(await codeOf(service.reveal(project, ''))).toBe('path-missing')
    expect(host.shown).toEqual([])
    expect(host.opened).toEqual([])
  })
})

test('a directory Explorer cannot open rejects with the shell error', async () => {
  await withFixture(async ({ root, project, host, service }) => {
    host.openPathResult = 'Access is denied.'
    await mkdir(join(root, 'locked'))
    expect(await codeOf(service.reveal(project, 'locked'))).toBe('reveal-failed')
  })
})

// ---------- External links, clipboard, picker ----------

test('only http and https URLs are opened in the default browser', async () => {
  await withFixture(async ({ host, service }) => {
    await service.openExternal('https://github.com/skflowne/spade')
    await service.openExternal('http://localhost:5173/app')
    expect(host.external).toEqual(['https://github.com/skflowne/spade', 'http://localhost:5173/app'])

    const rejected = [
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'ms-settings:privacy',
      'vscode://file/c:/x',
      'mailto:someone@example.com',
      'not a url',
      'https://',
      ''
    ]
    for (const url of rejected) expect(await codeOf(service.openExternal(url)), url).toBe('invalid-url')
    expect(host.external).toHaveLength(2)
  })
})

test('text is copied through the system clipboard', async () => {
  await withFixture(async ({ host, service }) => {
    service.copyText('C:\\Work\\app.ts:12')
    expect(host.clipboard).toEqual(['C:\\Work\\app.ts:12'])
  })
})

test('the image picker starts in the project root, filters to supported images, and returns the choice', async () => {
  await withFixture(async ({ root, project, host, service }) => {
    expect(await service.pickImage(project)).toBeNull()
    expect(host.dialogs).toEqual([{ defaultPath: root, extensions: [...IMAGE_EXTENSIONS] }])

    host.dialogResult = join(root, 'diagram.svg')
    expect(await service.pickImage(project)).toBe(join(root, 'diagram.svg'))

    host.dialogResult = join(root, 'payload.exe')
    expect(await codeOf(service.pickImage(project))).toBe('unsupported-image')
  })
})

// ---------- Image URLs and protocol ----------

test('image URLs round-trip file paths and asset ids', () => {
  const paths = [
    'C:\\Users\\Dev\\My Pictures\\shot #1 (final).png',
    'C:/work/a%20b?.jpeg',
    '\\\\server\\share\\images\\logo.svg',
    '\\\\?\\C:\\very\\long\\path\\image.webp',
    '/home/dev/project/été/图像.GIF'
  ]
  for (const path of paths) {
    const url = buildImageUrl({ kind: 'file', path }, 'rev1')
    expect(url.startsWith(`${IMAGE_PROTOCOL_SCHEME}://file/`)).toBe(true)
    expect(new URL(url).searchParams.get('v')).toBe('rev1')
    expect(parseImageUrl(url)).toEqual({ kind: 'file', path })
  }
  const assetUrl = buildImageUrl({ kind: 'asset', assetId: 'abc123' }, 'r')
  expect(assetUrl).toBe(`${IMAGE_PROTOCOL_SCHEME}://asset/abc123?v=r`)
  expect(parseImageUrl(assetUrl)).toEqual({ kind: 'asset', assetId: 'abc123' })
})

test('image URLs that name anything but an absolute, normalized image path or a safe asset id are rejected', () => {
  const file = (path: string) => `${IMAGE_PROTOCOL_SCHEME}://file/${encodeURIComponent(path)}`
  const rejected = [
    'https://example.com/a.png',
    `${IMAGE_PROTOCOL_SCHEME}://other/${encodeURIComponent('C:\\a.png')}`,
    file('C:\\Windows\\win.ini'),
    file('C:\\Users\\Dev\\payload.exe'),
    file('C:\\Users\\Dev'),
    file('relative\\image.png'),
    file('C:\\project\\..\\..\\secret.png'),
    file('/home/dev/./x.png'),
    file('\\\\.\\pipe\\x.png'),
    `${IMAGE_PROTOCOL_SCHEME}://file/C:/a/../b.png`,
    `${IMAGE_PROTOCOL_SCHEME}://file/%E0%A4%A.png`,
    `${IMAGE_PROTOCOL_SCHEME}://file/`,
    `${IMAGE_PROTOCOL_SCHEME}://asset/..%2Fsecret`,
    `${IMAGE_PROTOCOL_SCHEME}://asset/a/b`,
    `${IMAGE_PROTOCOL_SCHEME}://asset/CON`,
    'not a url'
  ]
  for (const url of rejected) expect(parseImageUrl(url), url).toBeNull()
})

test('the image protocol serves supported images read-only with their content type and an inert SVG policy', async () => {
  await withFixture(async ({ root, assets }) => {
    const handle = createImageRequestHandler({ resolveAsset: (id) => assets.resolve(id) })
    const get = (url: string, method = 'GET') => handle(new Request(url, { method }))
    const fileUrl = (name: string) => buildImageUrl({ kind: 'file', path: join(root, name) }, 'x')

    const image = png(3, 4)
    await writeFile(join(root, 'a.png'), image)
    const served = await get(fileUrl('a.png'))
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(image)

    // A mislabelled raster image is served as what it really is.
    await writeFile(join(root, 'photo.jpg'), image)
    expect((await get(fileUrl('photo.jpg'))).headers.get('content-type')).toBe('image/png')

    await writeFile(join(root, 'icon.svg'), `<svg ${SVG_NS} width="4" height="4"><script>alert(1)</script></svg>`)
    const svg = await get(fileUrl('icon.svg'))
    expect(svg.status).toBe(200)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    const policy = svg.headers.get('content-security-policy') ?? ''
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain('sandbox')

    const { assetId } = await assets.import({ data: gif(1, 1), mimeType: 'image/gif' })
    const asset = await get(buildImageUrl({ kind: 'asset', assetId }, 'x'))
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('image/gif')
  })
})

test('the image protocol refuses writes, non-images, directories, missing files, and unknown assets', async () => {
  await withFixture(async ({ root, assets }) => {
    const handle = createImageRequestHandler({ resolveAsset: (id) => assets.resolve(id) })
    const get = (url: string, method = 'GET') => handle(new Request(url, { method }))
    const fileUrl = (name: string) => buildImageUrl({ kind: 'file', path: join(root, name) }, 'x')

    await writeFile(join(root, 'a.png'), png(1, 1))
    await writeFile(join(root, 'notes.txt'), 'secret')
    await writeFile(join(root, 'fake.png'), 'secret')
    await writeFile(join(root, 'markup.png'), `<svg ${SVG_NS}/>`)
    await writeFile(join(root, 'empty.png'), '')
    await mkdir(join(root, 'folder.png'))

    for (const method of ['POST', 'PUT', 'DELETE']) expect((await get(fileUrl('a.png'), method)).status).toBe(405)
    const notServed = [
      `${IMAGE_PROTOCOL_SCHEME}://file/${encodeURIComponent(join(root, 'notes.txt'))}`,
      fileUrl('fake.png'),
      fileUrl('markup.png'),
      fileUrl('empty.png'),
      fileUrl('folder.png'),
      fileUrl('missing.png'),
      buildImageUrl({ kind: 'asset', assetId: 'unknown' }, 'x'),
      `${IMAGE_PROTOCOL_SCHEME}://file/${encodeURIComponent(`${root}/../project/a.png`)}`
    ]
    for (const url of notServed) {
      const response = await get(url)
      expect(response.status, url).toBeGreaterThanOrEqual(400)
      expect(response.headers.get('content-type'), url).not.toMatch(/^image\//)
    }
  })
})

// ---------- Dimensions ----------

test('image dimensions are read from PNG, GIF, JPEG, WebP, and SVG headers', () => {
  const cases: Array<[string, Uint8Array, { width: number; height: number } | null]> = [
    ['png', png(1920, 1080), { width: 1920, height: 1080 }],
    ['gif', gif(320, 200), { width: 320, height: 200 }],
    ['baseline jpeg', jpeg(800, 600), { width: 800, height: 600 }],
    ['progressive jpeg', jpeg(1024, 768, { sof: 0xc2 }), { width: 1024, height: 768 }],
    ['rotated jpeg', jpeg(4032, 3024, { orientation: 6 }), { width: 3024, height: 4032 }],
    ['rotated little-endian exif', jpeg(4032, 3024, { orientation: 8, littleEndianExif: true }), { width: 3024, height: 4032 }],
    ['upright jpeg with exif', jpeg(4032, 3024, { orientation: 1 }), { width: 4032, height: 3024 }],
    ['mirrored jpeg', jpeg(640, 480, { orientation: 2 }), { width: 640, height: 480 }],
    ['webp lossy', webpLossy(550, 368), { width: 550, height: 368 }],
    ['webp lossless', webpLossless(1000, 16383), { width: 1000, height: 16383 }],
    ['webp extended', webpExtended(5000, 3000), { width: 5000, height: 3000 }],
    ['svg size', text(`<svg ${SVG_NS} width="120" height="80px"/>`), { width: 120, height: 80 }],
    ['svg viewBox', text(`<?xml version="1.0"?>\n<!-- <svg width="1" height="1"> -->\n<svg ${SVG_NS} viewBox="0 0 300 150"></svg>`), { width: 300, height: 150 }],
    ['svg width and viewBox', text(`<svg ${SVG_NS} width="600" viewBox="0,0,300,150"/>`), { width: 600, height: 300 }],
    ['svg percentage size', text(`<svg ${SVG_NS} width="100%" height="100%" viewBox="0 0 40 20"/>`), { width: 40, height: 20 }],
    ['svg without size', text(`<svg ${SVG_NS}><rect/></svg>`), null],
    ['truncated png', png(10, 10).slice(0, 20), null],
    ['jpeg without frame', jpeg(10, 10).slice(0, 30), null],
    ['zero-sized gif', gif(0, 5), null]
  ]
  for (const [name, data, expected] of cases) {
    const type = sniffImageType(data)
    expect(type, name).not.toBeNull()
    expect(readImageDimensions(data, type!), name).toEqual(expected)
  }
})

test('image types are recognized from content, not from names', () => {
  expect(sniffImageType(png(1, 1))).toBe('png')
  expect(sniffImageType(jpeg(1, 1))).toBe('jpeg')
  expect(sniffImageType(gif(1, 1))).toBe('gif')
  expect(sniffImageType(webpLossy(1, 1))).toBe('webp')
  expect(sniffImageType(text(`\uFEFF  <?xml version="1.0"?><svg ${SVG_NS}/>`))).toBe('svg')
  for (const other of [text('hello'), text('<html><body></body></html>'), text('MZ\x90\x00'), new Uint8Array(), text('RIFF\0\0\0\0WAVE')]) {
    expect(sniffImageType(other)).toBeNull()
  }
})

// ---------- Sizing ----------

test('image nodes fit the image aspect ratio with a 560 longest side and a 240 minimum shortest side', () => {
  const cases: Array<[number, number, { width: number; height: number } | null]> = [
    [1600, 1200, { width: 560, height: 420 }],
    [1200, 1600, { width: 420, height: 560 }],
    [800, 800, { width: 560, height: 560 }],
    [100, 50, { width: 560, height: 280 }],
    [4000, 3001, { width: 560, height: 420 }],
    [1120, 480, { width: 560, height: 240 }],
    [1000, 333, { width: 560, height: 240 }],
    [3000, 500, { width: 560, height: 240 }],
    [500, 3000, { width: 240, height: 560 }],
    [0, 100, null],
    [Number.NaN, 100, null],
    [100, -5, null]
  ]
  for (const [width, height, expected] of cases) expect(fitImageNodeSize({ width, height }), `${width}x${height}`).toEqual(expected)
})

// ---------- describeImage ----------

test('describing a path image resolves it against the project root and returns its URL, size, and revision', async () => {
  await withFixture(async ({ root, project, service }) => {
    await mkdir(join(root, 'out'))
    await writeFile(join(root, 'out', 'chart.png'), png(640, 480))

    const info = await service.describeImage(project, { kind: 'path', path: 'out/chart.png' })
    expect(info).toMatchObject({ width: 640, height: 480 })
    expect(info.revision).not.toBe('')
    expect(info.url).toBe(buildImageUrl({ kind: 'file', path: join(root, 'out', 'chart.png') }, info.revision))

    await writeFile(join(root, 'out', 'chart.png'), png(320, 240))
    const changed = await service.describeImage(project, { kind: 'path', path: join(root, 'out', 'chart.png') })
    expect(changed).toMatchObject({ width: 320, height: 240 })
    expect(changed.revision).not.toBe(info.revision)
    expect(changed.url).not.toBe(info.url)
  })
})

test('describing an asset image reads it from the asset store', async () => {
  await withFixture(async ({ project, assets, service }) => {
    const { assetId } = await assets.import({ data: webpExtended(30, 20), mimeType: 'image/webp' })
    const info = await service.describeImage(project, { kind: 'asset', assetId })
    expect(info).toMatchObject({ width: 30, height: 20 })
    expect(info.url).toBe(buildImageUrl({ kind: 'asset', assetId }, info.revision))
  })
})

test('describing a missing, unsupported, or corrupt image rejects with a code the renderer can show', async () => {
  await withFixture(async ({ root, project, service }) => {
    await writeFile(join(root, 'notes.txt'), 'x')
    await writeFile(join(root, 'broken.png'), 'not an image')
    await mkdir(join(root, 'folder.png'))

    expect(await codeOf(service.describeImage(project, { kind: 'path', path: 'missing.png' }))).toBe('image-missing')
    expect(await codeOf(service.describeImage(project, { kind: 'path', path: 'folder.png' }))).toBe('image-missing')
    expect(await codeOf(service.describeImage(project, { kind: 'asset', assetId: 'unknown' }))).toBe('image-missing')
    expect(await codeOf(service.describeImage(project, { kind: 'asset', assetId: '../x' }))).toBe('image-missing')
    expect(await codeOf(service.describeImage(project, { kind: 'path', path: 'notes.txt' }))).toBe('unsupported-image')
    expect(await codeOf(service.describeImage(project, { kind: 'path', path: 'broken.png' }))).toBe('image-unreadable')
  })
})

test('an image with unknown dimensions is still described', async () => {
  await withFixture(async ({ root, project, service }) => {
    await writeFile(join(root, 'free.svg'), `<svg ${SVG_NS}><circle r="4"/></svg>`)
    expect(await service.describeImage(project, { kind: 'path', path: 'free.svg' })).toMatchObject({ width: null, height: null })
  })
})

test('importing an image stores it in the asset store', async () => {
  await withFixture(async ({ assets, service }) => {
    const data = png(2, 2)
    const { assetId } = await service.importImage({ data: data.buffer.slice(0) as ArrayBuffer, mimeType: 'image/png' })
    expect(await assets.resolve(assetId)).not.toBeNull()
    await expect(service.importImage({ data: new ArrayBuffer(4), mimeType: 'application/x-msdownload' })).rejects.toMatchObject({
      code: 'asset-rejected'
    })
  })
})

// ---------- Change notification ----------

const fastWatch = { watch: { pollIntervalMs: 20, debounceMs: 60 } }

function collectChanges(service: FileService): string[] {
  const changes: string[] = []
  service.subscribe((event) => {
    expect(event.type).toBe('image-changed')
    changes.push(event.path)
  })
  return changes
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

test('a described image file reports one debounced change when it is rewritten', async () => {
  await withFixture(async ({ root, project, service }) => {
    const path = join(root, 'live.png')
    await writeFile(path, png(1, 1))
    const changes = collectChanges(service)
    await service.describeImage(project, { kind: 'path', path: 'live.png' })
    await settle()
    expect(changes).toEqual([])

    await writeFile(path, png(2, 2))
    await writeFile(path, bytes([...png(3, 3)], [0]))
    await expect.poll(() => changes).toEqual([path])
    await settle()
    expect(changes).toEqual([path])
  }, fastWatch)
})

test('a described image reports changes when it disappears and when an editor replaces it', async () => {
  await withFixture(async ({ root, project, service }) => {
    const path = join(root, 'swap.png')
    await writeFile(path, png(1, 1))
    const changes = collectChanges(service)
    await service.describeImage(project, { kind: 'path', path })

    await unlink(path)
    await expect.poll(() => changes.length).toBe(1)

    await writeFile(join(root, 'swap.png.tmp'), bytes([...png(5, 5)], [0, 0]))
    await rename(join(root, 'swap.png.tmp'), path)
    await expect.poll(() => changes.length).toBe(2)
    expect(changes).toEqual([path, path])
  }, fastWatch)
})

test('an image described before it exists reports its creation', async () => {
  await withFixture(async ({ root, project, service }) => {
    const changes = collectChanges(service)
    expect(await codeOf(service.describeImage(project, { kind: 'path', path: 'later.png' }))).toBe('image-missing')
    await settle()
    expect(changes).toEqual([])
    await writeFile(join(root, 'later.png'), png(1, 1))
    await expect.poll(() => changes).toEqual([join(root, 'later.png')])
  }, fastWatch)
})

test('only the most recently described images are watched', async () => {
  await withFixture(
    async ({ root, project, service }) => {
      for (const name of ['a.png', 'b.png', 'c.png']) await writeFile(join(root, name), png(1, 1))
      const changes = collectChanges(service)
      for (const name of ['a.png', 'b.png', 'a.png', 'c.png']) await service.describeImage(project, { kind: 'path', path: name })

      for (const name of ['a.png', 'b.png', 'c.png']) await writeFile(join(root, name), png(9, 9))
      await expect.poll(() => [...changes].sort()).toEqual([join(root, 'a.png'), join(root, 'c.png')])
      await settle()
      expect(changes).toHaveLength(2)
    },
    { watch: { ...fastWatch.watch, maxWatchedImages: 2 } }
  )
})

test('stopping the service releases every watcher', async () => {
  await withFixture(async ({ root, project, service }) => {
    const path = join(root, 'still.png')
    await writeFile(path, png(1, 1))
    const changes = collectChanges(service)
    await service.describeImage(project, { kind: 'path', path })
    await service.stop()

    await writeFile(path, bytes([...png(2, 2)], [0]))
    await settle()
    expect(changes).toEqual([])

    await service.describeImage(project, { kind: 'path', path })
    await writeFile(path, png(3, 3))
    await settle()
    expect(changes).toEqual([])
  }, fastWatch)
})

// ---------- Entity adapters ----------

test('the image adapter stores a path image by absolute path in its config, with no resource reference, and fits the node to it', async () => {
  await withFixture(async ({ root, project, service }) => {
    await writeFile(join(root, 'wide.png'), png(1600, 900))
    const result = await service.imageEntityAdapter.create({
      nodeId: 'node-1',
      project,
      sourceNode: null,
      actor: userActor,
      config: { source: { kind: 'path', path: 'wide.png' }, caption: 'Wide' }
    })
    expect(result).toEqual({
      resourceRef: null,
      title: 'wide.png',
      config: { source: { kind: 'path', path: join(root, 'wide.png') }, caption: 'Wide' },
      size: { width: 560, height: 315 }
    })
  })
})

test('the image adapter keeps a node for a missing file, without a fitted size', async () => {
  await withFixture(async ({ root, project, service }) => {
    const result = await service.imageEntityAdapter.create({
      nodeId: 'node-1',
      project,
      sourceNode: null,
      actor: userActor,
      config: { source: { kind: 'path', path: 'later/plot.svg' } }
    })
    expect(result).toEqual({
      resourceRef: null,
      title: 'plot.svg',
      config: { source: { kind: 'path', path: join(root, 'later', 'plot.svg') } }
    })
  })
})

test('the image adapter keeps an asset image by asset id in its config only', async () => {
  await withFixture(async ({ project, assets, service }) => {
    const { assetId } = await assets.import({ data: gif(300, 600), mimeType: 'image/gif' })
    const result = await service.imageEntityAdapter.create({
      nodeId: 'node-1',
      project,
      sourceNode: null,
      actor: userActor,
      config: { source: { kind: 'asset', assetId } }
    })
    expect(result).toEqual({
      resourceRef: null,
      title: 'Image',
      config: { source: { kind: 'asset', assetId } },
      size: { width: 280, height: 560 }
    })
  })
})

test('the image adapter rejects malformed configs, non-image paths, and unknown assets', async () => {
  await withFixture(async ({ project, service }) => {
    const create = (config: unknown) =>
      service.imageEntityAdapter.create({ nodeId: 'n', project, sourceNode: null, actor: userActor, config })
    expect(await codeOf(create({}))).toBe('invalid-config')
    expect(await codeOf(create({ source: { kind: 'url', url: 'https://x' } }))).toBe('invalid-config')
    expect(await codeOf(create({ source: { kind: 'path', path: 'tool.exe' } }))).toBe('unsupported-image')
    expect(await codeOf(create({ source: { kind: 'asset', assetId: 'unknown' } }))).toBe('image-missing')
  })
})

test('the web page adapter keeps the URL in its config only and titles it with the host', async () => {
  await withFixture(async ({ project, service }) => {
    const create = (url: unknown) =>
      service.webPageEntityAdapter.create({ nodeId: 'node-7', project, sourceNode: null, actor: userActor, config: { url } })

    expect(await create('https://github.com/skflowne/spade/issues/14')).toEqual({
      resourceRef: null,
      title: 'github.com',
      config: { url: 'https://github.com/skflowne/spade/issues/14' }
    })
    expect(await create('http://localhost:5173')).toMatchObject({ title: 'localhost:5173', config: { url: 'http://localhost:5173/' } })
    for (const url of ['file:///C:/x.html', 'javascript:alert(1)', 'https://', 42]) expect(await codeOf(create(url)), String(url)).toBe('invalid-config')
  })
})

// ---------- Project safety ----------

test('no file service operation writes inside the project directory', async () => {
  await withFixture(async ({ root, project, host, service }) => {
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'a.png'), png(10, 10))
    await writeFile(join(root, 'run.exe'), 'MZ')
    await service.start()
    const before = await snapshotTree(root)

    await service.inspectPath(project, 'a.png:3')
    await service.inspectPath(project, 'missing/thing.ts')
    await service.reveal(project, 'run.exe')
    await service.reveal(project, 'docs')
    await service.describeImage(project, { kind: 'path', path: 'a.png' })
    await codeOf(service.describeImage(project, { kind: 'path', path: 'absent.png' }))
    await service.importImage({ data: png(1, 1).buffer.slice(0) as ArrayBuffer, mimeType: 'image/png' })
    host.dialogResult = join(root, 'a.png')
    await service.pickImage(project)
    await service.imageEntityAdapter.create({
      nodeId: 'n',
      project,
      sourceNode: null,
      actor: userActor,
      config: { source: { kind: 'path', path: 'a.png' } }
    })
    const response = await host.imageHandler!(new Request(buildImageUrl({ kind: 'file', path: join(root, 'a.png') }, 'x')))
    await response.arrayBuffer()
    await settle()

    expect(await snapshotTree(root)).toEqual(before)
  })
})

// ---------- Lifecycle and guest webview policy ----------

test('starting the service registers the image protocol and the guest policy; stopping releases them', async () => {
  await withFixture(async ({ root, host, service }) => {
    await service.start()
    expect(host.imageHandler).not.toBeNull()
    expect(host.webviews.listeners()).toBe(1)
    await writeFile(join(root, 'a.png'), png(1, 1))
    const response = await host.imageHandler!(new Request(buildImageUrl({ kind: 'file', path: join(root, 'a.png') }, 'x')))
    expect(response.status).toBe(200)

    await service.stop()
    expect(host.imageHandler).toBeNull()
    expect(host.webviews.listeners()).toBe(0)
    expect(host.webviews.session.requestHandler).toBeNull()
  })
})

test('attached webviews are forced into the persistent partition without preload or Node integration', () => {
  const webviews = createFakeWebviews()
  installWebviewPolicy(webviews.target)
  const embedder = webviews.create('window')

  const preferences: Record<string, unknown> = {
    preload: 'C:\\evil.js',
    nodeIntegration: true,
    contextIsolation: false,
    partition: 'other',
    disablePopups: true
  }
  const params: Record<string, string> = { src: 'https://github.com/' }
  const attach = new FakeEvent()
  embedder.emit('will-attach-webview', attach, preferences, params)

  expect(attach.defaultPrevented).toBe(false)
  expect(preferences.preload).toBeUndefined()
  expect(preferences.nodeIntegration).toBe(false)
  expect(preferences.nodeIntegrationInSubFrames).toBe(false)
  expect(preferences.contextIsolation).toBe(true)
  expect(preferences.sandbox).toBe(true)
  expect(preferences.webviewTag).toBe(false)
  expect(preferences.partition).toBe(WEB_PAGE_PARTITION)
  expect(preferences.disablePopups).toBe(false)
  expect(WEB_PAGE_PARTITION.startsWith('persist:')).toBe(true)

  for (const src of ['file:///C:/x.html', 'javascript:alert(1)', 'spade-image://file/x']) {
    const event = new FakeEvent()
    embedder.emit('will-attach-webview', event, {}, { src })
    expect(event.defaultPrevented, src).toBe(true)
  }
  for (const src of ['', 'about:blank', 'http://localhost:3000/']) {
    const event = new FakeEvent()
    embedder.emit('will-attach-webview', event, {}, { src })
    expect(event.defaultPrevented, src).toBe(false)
  }
})

test('guest popups are denied and navigate the same guest, and guests only navigate to web pages', () => {
  const webviews = createFakeWebviews()
  installWebviewPolicy(webviews.target)
  const guest = webviews.create('webview')

  expect(guest.windowOpenHandler!({ url: 'https://github.com/electron/electron/issues' })).toEqual({ action: 'deny' })
  expect(guest.windowOpenHandler!({ url: 'file:///C:/Windows/win.ini' })).toEqual({ action: 'deny' })
  expect(guest.loaded).toEqual(['https://github.com/electron/electron/issues'])

  for (const event of ['will-navigate', 'will-redirect']) {
    const allowed = new FakeEvent('https://example.com/next')
    guest.emit(event, allowed, allowed.url)
    expect(allowed.defaultPrevented).toBe(false)
    for (const url of ['file:///C:/x', 'zoommtg://join', 'chrome://settings']) {
      const denied = new FakeEvent(url)
      guest.emit(event, denied, url)
      expect(denied.defaultPrevented, `${event} ${url}`).toBe(true)
    }
  }

  const hostWindow = webviews.create('window')
  expect(hostWindow.windowOpenHandler).toBeNull()
})

test('guest sessions deny permissions by default and cancel downloads', () => {
  const webviews = createFakeWebviews()
  installWebviewPolicy(webviews.target)
  const { session } = webviews

  for (const permission of ['media', 'geolocation', 'notifications', 'openExternal', 'clipboard-read', 'midiSysex', 'unknown']) {
    expect(session.requestPermission(permission), permission).toBe(false)
    expect(session.checkHandler!(null, permission), permission).toBe(false)
  }
  for (const permission of ['clipboard-sanitized-write', 'fullscreen']) {
    expect(session.requestPermission(permission), permission).toBe(true)
    expect(session.checkHandler!(null, permission), permission).toBe(true)
  }

  const download = new FakeEvent()
  session.emit('will-download', download, { getURL: () => 'https://example.com/setup.exe' })
  expect(download.defaultPrevented).toBe(true)
})
