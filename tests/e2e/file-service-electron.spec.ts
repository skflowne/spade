import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { build } from 'esbuild'
import type { FileService } from '../../src/main/contracts'
import { WEB_PAGE_PARTITION } from '../../src/shared/builtinEntities'
import type { Project } from '../../src/shared/domain'

// Wires the real Electron binding of the file service into a minimal app, so the image protocol and the
// guest webview policy run inside Chromium rather than against fakes.
const HARNESS = `
import { app, BrowserWindow, ipcMain } from 'electron'
import { createElectronFileServiceHost, createFileService, registerFileServiceSchemes } from './src/main/files'
import { AssetStore } from './src/main/persistence'

app.setPath('userData', process.env.SPADE_HARNESS_DATA)
registerFileServiceSchemes()
const probe = { preloadRuns: 0 }
ipcMain.on('preload-ran', () => probe.preloadRuns++)
void app.whenReady().then(async () => {
  const service = createFileService({
    host: createElectronFileServiceHost(),
    assetStore: new AssetStore({ directory: app.getPath('userData') })
  })
  await service.start()
  Object.assign(globalThis, { fileService: service, probe })
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: true }
  })
  await window.loadURL('data:text/html,<!doctype html><title>harness</title><body></body>')
})
app.on('window-all-closed', () => app.quit())
`

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

// A decodable RGBA PNG.
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const rows = Buffer.alloc(height * (1 + width * 4), 0x7f)
  for (let row = 0; row < height; row++) rows[row * (1 + width * 4)] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

type Harness = { app: ElectronApplication; window: Page; directory: string; root: string; project: Project }

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'spade-files-electron-'))
  const root = join(directory, 'project')
  const data = join(directory, 'app-data')
  await mkdir(root)
  await mkdir(data)
  const main = join(directory, 'main.cjs')
  await build({
    stdin: { contents: HARNESS, resolveDir: resolve('.'), loader: 'ts', sourcefile: 'harness.ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    outfile: main,
    logLevel: 'silent'
  })
  const app = await electron.launch({ args: [main], env: { ...process.env, SPADE_HARNESS_DATA: data } })
  try {
    const window = await app.firstWindow()
    await expect.poll(() => app.evaluate(() => 'fileService' in globalThis)).toBe(true)
    const project: Project = { version: 2, id: 'p', name: 'P', rootPath: root, createdAt: '2026-01-01T00:00:00.000Z' }
    await run({ app, window, directory, root, project })
  } finally {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
}

function describeImage(app: ElectronApplication, project: Project, path: string) {
  return app.evaluate(
    (_electron, input) =>
      (globalThis as unknown as { fileService: FileService }).fileService.describeImage(input.project, {
        kind: 'path',
        path: input.path
      }),
    { project, path }
  )
}

function decode(window: Page, url: string) {
  return window.evaluate(async (src) => {
    const image = new Image()
    image.src = src
    try {
      await image.decode()
      return { width: image.naturalWidth, height: image.naturalHeight }
    } catch {
      return null
    }
  }, url)
}

test('the renderer shows project images through the image protocol, including SVG and unusual file names', async () => {
  await withHarness(async ({ app, window, root, project }) => {
    const name = 'shot #1 (été) 100%.png'
    await writeFile(join(root, name), png(3, 2))
    await writeFile(
      join(root, 'diagram.svg'),
      `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><script>top.document.title='ran'</script><rect width="40" height="20"/></svg>`
    )
    await writeFile(join(root, 'notes.txt'), 'secret')

    const photo = await describeImage(app, project, name)
    expect(photo).toMatchObject({ width: 3, height: 2 })
    expect(await decode(window, photo.url)).toEqual({ width: 3, height: 2 })

    const svg = await describeImage(app, project, 'diagram.svg')
    expect(await decode(window, svg.url)).toEqual({ width: 40, height: 20 })
    expect(await window.title()).toBe('harness')

    expect(await decode(window, `spade-image://file/${encodeURIComponent(join(root, 'notes.txt'))}`)).toBeNull()
    expect(await decode(window, `spade-image://file/${encodeURIComponent(join(root, 'missing.png'))}`)).toBeNull()
  })
})

async function withWebServer(run: (origin: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(`<title>${request.url}</title>`)
  })
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    await new Promise((closed) => server.close(closed))
  }
}

function inGuest(app: ElectronApplication, script: string, userGesture = false): Promise<unknown> {
  return app.evaluate(
    ({ webContents }, input) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getType() === 'webview')
      return guest?.executeJavaScript(input.script, input.userGesture)
    },
    { script, userGesture }
  )
}

test('web page guests run in the persistent partition without Node or preload, and popups stay in the same guest', async () => {
  await withWebServer(async (origin) => {
    await withHarness(async ({ app, window, directory }) => {
      const preload = join(directory, 'preload.js')
      await writeFile(preload, `require('electron').ipcRenderer.send('preload-ran')`)
      await window.evaluate(
        ({ src, preload }) => {
          const guest = document.createElement('webview')
          guest.setAttribute('src', src)
          guest.setAttribute('partition', 'persist:elsewhere')
          guest.setAttribute('preload', preload)
          guest.setAttribute('nodeintegration', '')
          guest.style.cssText = 'width:800px;height:600px;display:inline-flex'
          document.body.append(guest)
        },
        { src: `${origin}/first`, preload: pathToFileURL(preload).href }
      )

      const guestState = () =>
        app.evaluate(({ webContents, session }, partition) => {
          const guests = webContents.getAllWebContents().filter((contents) => contents.getType() === 'webview')
          return guests.map((guest) => ({
            url: guest.getURL(),
            persistentSession: guest.session === session.fromPartition(partition)
          }))
        }, WEB_PAGE_PARTITION)

      await expect.poll(async () => (await guestState())[0]?.url).toBe(`${origin}/first`)
      expect(await guestState()).toEqual([{ url: `${origin}/first`, persistentSession: true }])
      expect(await inGuest(app, `typeof require + ' ' + typeof process`)).toBe('undefined undefined')

      const windowsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
      await inGuest(app, `void window.open('/popup')`, true)
      await expect.poll(async () => (await guestState()).map((guest) => guest.url)).toEqual([`${origin}/popup`])
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windowsBefore)

      expect(await inGuest(app, `navigator.permissions.query({ name: 'geolocation' }).then((status) => status.state)`)).toBe('denied')
      expect(await app.evaluate(() => (globalThis as unknown as { probe: { preloadRuns: number } }).probe.preloadRuns)).toBe(0)
    })
  })
})
