import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { PREVIEW_ZOOM_THRESHOLD } from '../../src/renderer/src/canvas/model/levelOfDetail'
import {
  canvasNode,
  expectClearOfMinimap,
  fitAll,
  launch,
  nodeBody,
  nodeHeader,
  nodeMenu,
  openProjectFromSidebar,
  readCanvas,
  renderedViewport,
  scratchDirectory,
  type Spade
} from './ui-harness'

// Two small pages served locally; each page load gets a fresh random token, so an unchanged token proves
// the guest did not reload.
const PAGES: Record<string, string> = {
  '/a': `<!doctype html><title>Page A</title>
    <style>body { margin: 0; font: 16px sans-serif } main { height: 4000px; padding: 24px }</style>
    <main>
      <h1>Page A</h1>
      <a id="to-b" href="/b">Go to B</a>
      <a id="blank-b" href="/b" target="_blank">Open B in a new window</a>
    </main>
    <script>
      window.__token = Math.random()
      window.__keys = []
      window.__presses = 0
      addEventListener('keydown', (event) => window.__keys.push(event.key))
      addEventListener('mousedown', () => (window.__presses += 1))
    </script>`,
  '/b': `<!doctype html><title>Page B</title><main><h1>Page B</h1><a id="to-a" href="/a">Go to A</a></main>
    <script>window.__token = Math.random()</script>`
}

let scratch: string
let server: Server
let origin: string

test.beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'spade-webpage-'))
  server = createServer((request, response) => {
    const page = PAGES[new URL(request.url ?? '/', 'http://localhost').pathname]
    if (!page) {
      response.writeHead(404).end('Not found')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(scratch, { recursive: true, force: true })
})

type GuestInfo = { id: number; url: string; title: string }

async function guests(app: ElectronApplication): Promise<GuestInfo[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((contents) => contents.getType() === 'webview' && !contents.isDestroyed())
      .map((contents) => ({ id: contents.id, url: contents.getURL(), title: contents.getTitle() }))
  )
}

// Runs with a user gesture, as a click would: Chromium skips gesture-less history entries in Back/Forward.
async function inGuest<Result>(app: ElectronApplication, id: number, code: string): Promise<Result> {
  return app.evaluate(
    ({ webContents }, [guestId, script]) => webContents.fromId(guestId)!.executeJavaScript(script, true),
    [id, code] as const
  )
}

// Counts the guest's loads from now on, in the main process.
async function countLoads(app: ElectronApplication, id: number): Promise<void> {
  await app.evaluate(({ webContents }, guestId) => {
    const counters = ((globalThis as Record<string, unknown>).__spadeLoads ??= {}) as Record<number, number>
    counters[guestId] = 0
    webContents.fromId(guestId)!.on('did-start-loading', () => (counters[guestId] += 1))
  }, id)
}

async function loadsOf(app: ElectronApplication, id: number): Promise<number> {
  return app.evaluate((_electron, guestId) => ((globalThis as Record<string, unknown>).__spadeLoads as Record<number, number>)[guestId], id)
}

async function guestAt(app: ElectronApplication, url: string): Promise<GuestInfo> {
  await expect.poll(async () => (await guests(app)).map((guest) => guest.url)).toEqual([url])
  return (await guests(app))[0]
}

async function launchWithProject(userData?: string): Promise<Spade> {
  const spade = await launch(userData ?? (await scratchDirectory(scratch, 'user-data')))
  await openProjectFromSidebar(spade, await scratchDirectory(scratch, 'project'))
  await expect(spade.page.getByTestId('canvas')).toBeVisible()
  return spade
}

async function createWebPageFromToolbar(page: Page, address: string): Promise<void> {
  await page.getByRole('toolbar', { name: 'Canvas' }).getByRole('button', { name: 'New node' }).click()
  await page.getByRole('menu', { name: 'New node' }).getByRole('menuitem', { name: 'Web page' }).click()
  const dialog = page.getByRole('dialog', { name: 'New web page' })
  await dialog.getByLabel('URL', { exact: true }).fill(address)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
}

async function webPageUrl(page: Page): Promise<string | undefined> {
  const node = (await readCanvas(page)).nodes.find((candidate) => candidate.entityType === 'webpage')
  return (node?.config as { url?: string } | undefined)?.url
}

function hostTitle(): string {
  return new URL(origin).host
}

test('a web page node opens, follows navigation, and reopens where the user left it', async () => {
  test.setTimeout(90_000)
  const userData = await scratchDirectory(scratch, 'user-data')
  const spade = await launchWithProject(userData)
  const { app, page } = spade

  await createWebPageFromToolbar(page, `${origin}/a`)
  const title = hostTitle()
  await expect(canvasNode(page, title)).toBeVisible()
  await expect(canvasNode(page, title).getByTestId('webpage-guest')).toBeVisible()
  const first = await guestAt(app, `${origin}/a`)
  await expect.poll(async () => (await guests(app))[0]?.title).toBe('Page A')
  await expect(nodeHeader(page, title).getByText('Page A')).toBeVisible()
  expect(await webPageUrl(page)).toBe(`${origin}/a`)

  // Following a link moves the node's durable URL.
  await inGuest(app, first.id, `document.getElementById('to-b').click()`)
  await guestAt(app, `${origin}/b`)
  await expect.poll(() => webPageUrl(page)).toBe(`${origin}/b`)

  // Back and Forward in the node's bar, once the body is active.
  const body = nodeBody(page, title)
  await body.click()
  await expect(body).toHaveAttribute('data-active', 'true')
  const bar = body.getByRole('toolbar', { name: 'Page navigation' })
  await bar.getByRole('button', { name: 'Back' }).click()
  await guestAt(app, `${origin}/a`)
  await expect(bar.getByLabel('Address')).toHaveValue(`${origin}/a`)
  await bar.getByRole('button', { name: 'Forward' }).click()
  await guestAt(app, `${origin}/b`)

  // The address field navigates on Enter.
  await bar.getByLabel('Address').fill(`${origin}/a`)
  await bar.getByLabel('Address').press('Enter')
  await guestAt(app, `${origin}/a`)
  await expect.poll(() => webPageUrl(page)).toBe(`${origin}/a`)

  await app.close()
  const relaunched = await launch(userData)
  await expect(canvasNode(relaunched.page, title).getByTestId('webpage-guest')).toBeVisible()
  await guestAt(relaunched.app, `${origin}/a`)
  await relaunched.app.close()
})

test('the guest stays live through pan, zoom, resize, and selection', async () => {
  test.setTimeout(90_000)
  const { app, page } = await launchWithProject()
  await createWebPageFromToolbar(page, `${origin}/a`)
  const title = hostTitle()
  const guest = await guestAt(app, `${origin}/a`)
  await expect.poll(async () => (await guests(app))[0]?.title).toBe('Page A')
  const token = await inGuest<number>(app, guest.id, 'window.__token')
  await countLoads(app, guest.id)

  const canvas = page.getByTestId('canvas')
  const box = (await canvas.boundingBox())!
  const before = await renderedViewport(page)

  // Pan by dragging empty canvas.
  await page.mouse.move(box.x + 20, box.y + box.height - 20)
  await page.mouse.down()
  await page.mouse.move(box.x + 140, box.y + box.height - 80, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await renderedViewport(page)).x).not.toBe(before.x)

  // Zoom out and back in. The page keeps the layout width it has at 100%: it is drawn at its on-screen
  // size with a matching page zoom, not reflowed into a narrower viewport.
  const toolbar = page.getByRole('toolbar', { name: 'Canvas' })
  const flowWidth = async (): Promise<number> => {
    const zoom = (await renderedViewport(page)).zoom
    return (await canvasNode(page, title).locator('.webpage__surface').boundingBox())!.width / zoom
  }
  const layoutWidth = await flowWidth()
  await expect.poll(() => inGuest<number>(app, guest.id, 'innerWidth')).toBeCloseTo(layoutWidth, -1)
  await toolbar.getByRole('button', { name: 'Zoom out' }).click()
  await expect.poll(async () => (await renderedViewport(page)).zoom).toBeLessThan(before.zoom)
  await expect.poll(() => inGuest<number>(app, guest.id, 'innerWidth')).toBeCloseTo(layoutWidth, -1)
  await toolbar.getByRole('button', { name: 'Zoom in' }).click()
  await toolbar.getByRole('button', { name: 'Zoom in' }).click()

  // Fit all leaves the node clear of the minimap; select it, then resize it from its bottom-right grip.
  await fitAll(page)
  const node = canvasNode(page, title)
  await expectClearOfMinimap(page, node)
  await nodeHeader(page, title).click()
  const nodeBox = (await node.boundingBox())!
  const grip = (await page.locator('.react-flow__resize-control.handle.bottom.right').boundingBox())!
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 - 160, grip.y + grip.height / 2 - 120, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await node.boundingBox())!.width).toBeLessThan(nodeBox.width - 100)
  await expect
    .poll(async () => (await readCanvas(page)).nodes.find((candidate) => candidate.entityType === 'webpage')?.size?.width)
    .toBeLessThan(900)

  // The guest webContents never changed, never reloaded, and still fills the resized body.
  expect((await guests(app)).map((candidate) => candidate.id)).toEqual([guest.id])
  expect(await inGuest<number>(app, guest.id, 'window.__token')).toBe(token)
  expect(await loadsOf(app, guest.id)).toBe(0)
  const surface = (await node.locator('.webpage__surface').boundingBox())!
  const shown = (await node.getByTestId('webpage-guest').boundingBox())!
  expect(Math.abs(shown.width - surface.width)).toBeLessThan(2)
  expect(Math.abs(shown.height - surface.height)).toBeLessThan(2)
  await app.close()
})

test('a page mounts its guest only once it comes into view', async () => {
  const userData = await scratchDirectory(scratch, 'user-data')
  const first = await launchWithProject(userData)
  await createWebPageFromToolbar(first.page, `${origin}/a`)
  await guestAt(first.app, `${origin}/a`)
  const moved = await first.page.evaluate(async () => {
    const host = (window as unknown as { spadeHost: import('../../src/shared/ipc').SpadeHostBridge }).spadeHost
    const projectId = (await host.app.getState()).selectedProjectId!
    return host.canvas.execute(projectId, { type: 'setViewport', viewport: { x: -40_000, y: -40_000, zoom: 1 } })
  })
  expect(moved.ok).toBe(true)
  await first.app.close()

  const { app, page } = await launch(userData)
  await expect(page.getByTestId('canvas-node')).toHaveCount(1)
  await page.waitForTimeout(500)
  expect(await guests(app)).toEqual([])
  await expect(page.getByTestId('webpage-placeholder')).toHaveCount(1)

  await fitAll(page)
  await guestAt(app, `${origin}/a`)
  await expect(page.getByTestId('webpage-placeholder')).toHaveCount(0)
  await app.close()
})

test('a canvas keeps at most twelve live pages, and activating a paused page brings it back', async () => {
  test.setTimeout(90_000)
  const { app, page } = await launchWithProject()
  const projectId = (await readCanvas(page)).projectId
  // A 5×3 grid of small pages, so all thirteen fit in view at once at a zoom that shows full bodies.
  for (let index = 0; index < 13; index += 1) {
    const created = await page.evaluate(
      async ([target, url, title, x, y]) => {
        const host = (window as unknown as { spadeHost: import('../../src/shared/ipc').SpadeHostBridge }).spadeHost
        const node = { entityType: 'webpage', config: { url }, title, position: { x, y }, size: { width: 300, height: 240 } }
        return host.canvas.execute(target, { type: 'startTree', node })
      },
      [projectId, `${origin}/b?page=${index}`, `Page ${index}`, (index % 5) * 340, Math.floor(index / 5) * 300] as const
    )
    expect(created.ok).toBe(true)
  }
  await fitAll(page)
  expect((await renderedViewport(page)).zoom).toBeGreaterThanOrEqual(PREVIEW_ZOOM_THRESHOLD)
  await expect.poll(async () => (await guests(app)).length).toBe(12)
  await expect(page.getByTestId('webpage-placeholder')).toHaveCount(1)

  const paused = page.getByTestId('canvas-node').filter({ has: page.getByTestId('webpage-placeholder') })
  const pausedTitle = (await paused.getByRole('heading').textContent())!
  await nodeBody(page, pausedTitle).click()
  await expect(canvasNode(page, pausedTitle).getByTestId('webpage-guest')).toBeVisible()
  await expect.poll(async () => (await guests(app)).length).toBe(12)
  await expect(page.getByTestId('webpage-placeholder')).toHaveCount(1)
  await expect(paused.getByRole('heading')).not.toHaveText(pausedTitle)
  await app.close()
})

test('popups navigate the same guest and open no window', async () => {
  const { app, page } = await launchWithProject()
  await createWebPageFromToolbar(page, `${origin}/a`)
  const guest = await guestAt(app, `${origin}/a`)

  await inGuest(app, guest.id, `window.open('/b', '_blank'); true`)
  await guestAt(app, `${origin}/b`)
  await inGuest(app, guest.id, `document.getElementById('to-a').click()`)
  await guestAt(app, `${origin}/a`)
  await inGuest(app, guest.id, `document.getElementById('blank-b').click()`)
  await guestAt(app, `${origin}/b`)

  expect((await guests(app)).map((candidate) => candidate.id)).toEqual([guest.id])
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  await app.close()
})

test('collapsing unmounts the guest and expanding restores the page', async () => {
  const { app, page } = await launchWithProject()
  await createWebPageFromToolbar(page, `${origin}/a`)
  const title = hostTitle()
  const guest = await guestAt(app, `${origin}/a`)
  await inGuest(app, guest.id, `document.getElementById('to-b').click()`)
  await guestAt(app, `${origin}/b`)

  await nodeMenu(page, title, 'Collapse node')
  await expect(canvasNode(page, title).getByTestId('node-body')).toHaveCount(0)
  await expect.poll(async () => (await guests(app)).length).toBe(0)
  await expect.poll(() => webPageUrl(page)).toBe(`${origin}/b`)

  await nodeMenu(page, title, 'Expand node')
  const restored = await guestAt(app, `${origin}/b`)
  expect(restored.id).not.toBe(guest.id)
  await app.close()
})

test('zooming out to the preview level unmounts the guest and zooming back in restores the page', async () => {
  const { app, page } = await launchWithProject()
  await createWebPageFromToolbar(page, `${origin}/a`)
  const title = hostTitle()
  const guest = await guestAt(app, `${origin}/a`)
  await inGuest(app, guest.id, `document.getElementById('to-b').click()`)
  await guestAt(app, `${origin}/b`)

  const toolbar = page.getByRole('toolbar', { name: 'Canvas' })
  while ((await renderedViewport(page)).zoom >= PREVIEW_ZOOM_THRESHOLD) {
    await toolbar.getByRole('button', { name: 'Zoom out' }).click()
  }
  await expect(nodeBody(page, title)).toHaveAttribute('data-detail', 'preview')
  await expect.poll(async () => (await guests(app)).length).toBe(0)
  await expect(canvasNode(page, title).getByTestId('webpage-placeholder')).toContainText(`${origin}/b`)

  while ((await renderedViewport(page)).zoom < PREVIEW_ZOOM_THRESHOLD) {
    await toolbar.getByRole('button', { name: 'Zoom in' }).click()
  }
  await expect(nodeBody(page, title)).toHaveAttribute('data-detail', 'full')
  const restored = await guestAt(app, `${origin}/b`)
  expect(restored.id).not.toBe(guest.id)
  await expect(canvasNode(page, title).getByTestId('webpage-placeholder')).toHaveCount(0)
  await app.close()
})

test('the inactive page leaves wheel to the canvas; the active page takes wheel and keys until Escape', async () => {
  test.setTimeout(60_000)
  const { app, page } = await launchWithProject()
  await createWebPageFromToolbar(page, `${origin}/a`)
  const title = hostTitle()
  const guest = await guestAt(app, `${origin}/a`)
  await expect.poll(async () => (await guests(app))[0]?.title).toBe('Page A')
  const body = nodeBody(page, title)
  const surface = canvasNode(page, title).locator('.webpage__surface')
  await expect(body).toHaveAttribute('data-active', 'false')

  // Inactive: the wheel over the page zooms the canvas and does not scroll the page.
  const box = (await surface.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const before = await renderedViewport(page)
  await page.mouse.wheel(0, 300)
  await expect.poll(async () => (await renderedViewport(page)).zoom).not.toBe(before.zoom)
  expect(await inGuest<number>(app, guest.id, 'scrollY')).toBe(0)

  // The click that activates the body belongs to the canvas, not the page; later clicks reach the page.
  const activeBox = (await surface.boundingBox())!
  await page.mouse.click(activeBox.x + activeBox.width / 2, activeBox.y + activeBox.height / 2)
  await expect(body).toHaveAttribute('data-active', 'true')
  expect(await inGuest<number>(app, guest.id, 'window.__presses')).toBe(0)
  // The browser routes input to the guest once its next frames carry the updated hit-test data.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.mouse.click(activeBox.x + activeBox.width / 2, activeBox.y + activeBox.height / 2)
  await expect.poll(() => inGuest<number>(app, guest.id, 'window.__presses')).toBe(1)

  // Active: the page scrolls and the canvas stays put.
  const zoomed = await renderedViewport(page)
  await page.mouse.move(activeBox.x + activeBox.width / 2, activeBox.y + activeBox.height / 2)
  await page.mouse.wheel(0, 400)
  await expect.poll(() => inGuest<number>(app, guest.id, 'scrollY')).toBeGreaterThan(0)
  expect(await renderedViewport(page)).toEqual(zoomed)

  // Keys reach the page; Escape inside the page returns control to the canvas.
  await page.keyboard.press('k')
  await expect.poll(() => inGuest<string[]>(app, guest.id, 'window.__keys')).toContain('k')
  await page.keyboard.press('Escape')
  await expect(body).toHaveAttribute('data-active', 'false')
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('WEBVIEW')
  await app.close()
})

test('a page that fails to load shows the failure with Retry', async () => {
  const { app, page } = await launchWithProject()
  const closed = createServer()
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
  const port = (closed.address() as AddressInfo).port
  await new Promise<void>((resolve) => closed.close(() => resolve()))

  await createWebPageFromToolbar(page, `127.0.0.1:${port}/nothing`)
  const title = `127.0.0.1:${port}`
  const failure = canvasNode(page, title).getByTestId('webpage-failure')
  await expect(failure).toBeVisible()
  await expect(failure).toContainText(`http://127.0.0.1:${port}/nothing`)
  await expect(nodeHeader(page, title).getByText('Failed')).toBeVisible()

  // Retry once something listens there.
  const late = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' }).end('<title>Back up</title><h1>Back up</h1>')
  })
  await new Promise<void>((resolve) => late.listen(port, '127.0.0.1', resolve))
  try {
    await nodeBody(page, title).click()
    await failure.getByRole('button', { name: 'Retry' }).click()
    await expect(failure).toBeHidden()
    await expect.poll(async () => (await guests(app))[0]?.title).toBe('Back up')
  } finally {
    late.closeAllConnections()
    await new Promise<void>((resolve) => late.close(() => resolve()))
  }
  await app.close()
})
