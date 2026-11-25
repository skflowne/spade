import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { CanvasCommand, CanvasCommandResponse } from '../../src/shared/commands'
import type { Canvas, Viewport } from '../../src/shared/domain'
import type { AppState, SpadeHostBridge } from '../../src/shared/ipc'

// Drives the real renderer UI of an isolated SPADE instance.

type HostWindow = Window & { spadeHost: SpadeHostBridge }

export type Spade = { app: ElectronApplication; page: Page }

export async function scratchDirectory(parent: string, name: string): Promise<string> {
  return mkdtemp(join(parent, `${name}-`))
}

export async function launch(userDataDirectory: string): Promise<Spade> {
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${userDataDirectory}`],
    // UI specs never reach a real Paseo daemon.
    env: { ...process.env, SPADE_DISABLE_PASEO: '1' }
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.waitForFunction(() => 'spadeHost' in window)
  await expect(page.getByTestId('app-shell')).toBeVisible()
  return { app, page }
}

// The next native folder pick in the main process returns `directory`.
export async function pickNext(app: ElectronApplication, directory: string): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
  }, directory)
}

export async function openProjectFromSidebar({ app, page }: Spade, directory: string): Promise<void> {
  await pickNext(app, directory)
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Open project…' }).click()
}

export function projectList(page: Page): Locator {
  return page.getByRole('list', { name: 'Projects' })
}

export function projectButton(page: Page, name: string): Locator {
  return projectList(page).getByRole('button', { name, exact: true })
}

export async function appState(page: Page): Promise<AppState> {
  return page.evaluate(() => (window as unknown as HostWindow).spadeHost.app.getState())
}

export async function selectedProjectId(page: Page): Promise<string> {
  const id = (await appState(page)).selectedProjectId
  if (id === null) throw new Error('No project is selected')
  return id
}

export async function readCanvas(page: Page, projectId?: string): Promise<Canvas> {
  const id = projectId ?? (await selectedProjectId(page))
  return page.evaluate((target) => (window as unknown as HostWindow).spadeHost.canvas.get(target), id)
}

export async function execute(page: Page, command: CanvasCommand, projectId?: string): Promise<CanvasCommandResponse> {
  const id = projectId ?? (await selectedProjectId(page))
  return page.evaluate(
    ([target, issued]) => (window as unknown as HostWindow).spadeHost.canvas.execute(target, issued),
    [id, command] as const
  )
}

export async function nodeIdByTitle(page: Page, title: string): Promise<string> {
  const node = (await readCanvas(page)).nodes.find((candidate) => candidate.title === title)
  if (!node) throw new Error(`No node titled ${title}`)
  return node.id
}

export function canvasNode(page: Page, title: string): Locator {
  return page.getByTestId('canvas-node').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
}

export function nodeHeader(page: Page, title: string): Locator {
  return canvasNode(page, title).getByTestId('node-header')
}

export function nodeBody(page: Page, title: string): Locator {
  return canvasNode(page, title).getByTestId('node-body')
}

export async function nodeMenu(page: Page, title: string, item: string): Promise<void> {
  await canvasNode(page, title).getByRole('button', { name: 'Node actions' }).click()
  await page.getByRole('menu', { name: `Actions for ${title}` }).getByRole('menuitem', { name: item }).click()
}

// The rendered canvas transform: screen = flow * zoom + (x, y).
export async function renderedViewport(page: Page): Promise<Viewport> {
  const transform = await page.locator('.react-flow__viewport').evaluate((element) => getComputedStyle(element).transform)
  const match = /matrix\(([^,]+), [^,]+, [^,]+, [^,]+, ([^,]+), ([^)]+)\)/.exec(transform)
  if (!match) return { x: 0, y: 0, zoom: 1 }
  return { zoom: Number(match[1]), x: Number(match[2]), y: Number(match[3]) }
}

export async function createNoteFromToolbar(
  page: Page,
  input: { title: string; body?: string }
): Promise<void> {
  await page.getByRole('toolbar', { name: 'Canvas' }).getByRole('button', { name: 'New node' }).click()
  await page.getByRole('menu', { name: 'New node' }).getByRole('menuitem', { name: 'Note' }).click()
  const dialog = page.getByRole('dialog', { name: 'New note' })
  await dialog.getByLabel('Title', { exact: true }).fill(input.title)
  if (input.body !== undefined) await dialog.getByLabel('Text', { exact: true }).fill(input.body)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  await expect(canvasNode(page, input.title)).toBeVisible()
}

export async function expectNoNotice(page: Page): Promise<void> {
  await expect(page.getByRole('region', { name: 'Notices' }).getByRole('alert')).toHaveCount(0)
}

// The element lies wholly outside the shown minimap, so the minimap cannot take the pointer from its edges.
export async function expectClearOfMinimap(page: Page, element: Locator): Promise<void> {
  const minimap = (await page.getByRole('img', { name: 'Minimap' }).boundingBox())!
  const box = (await element.boundingBox())!
  const overlaps =
    box.x < minimap.x + minimap.width &&
    minimap.x < box.x + box.width &&
    box.y < minimap.y + minimap.height &&
    minimap.y < box.y + box.height
  expect(overlaps, `${JSON.stringify(box)} overlaps the minimap at ${JSON.stringify(minimap)}`).toBe(false)
}

type Box = { x: number; y: number; width: number; height: number }

// The part of the canvas no overlay covers, in page coordinates: below the shown breadcrumb and above the shown
// minimap. Measured from the rendered overlays, independently of how the canvas computes its focus.
export async function unobstructedArea(page: Page): Promise<Box> {
  const pane = (await page.getByTestId('canvas').boundingBox())!
  const breadcrumb = page.getByRole('navigation', { name: 'Current focus' })
  const minimap = page.getByRole('img', { name: 'Minimap' })
  const bar = (await breadcrumb.count()) > 0 ? await breadcrumb.boundingBox() : null
  const top = bar ? bar.y + bar.height : pane.y
  const bottom = (await minimap.count()) > 0 ? (await minimap.boundingBox())!.y : pane.y + pane.height
  return { x: pane.x, y: top, width: pane.width, height: bottom - top }
}

// The element's center sits on the center of the unobstructed canvas area, within a few pixels.
export async function expectCenteredInView(page: Page, element: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const box = await element.boundingBox()
      if (!box) return Number.POSITIVE_INFINITY
      const area = await unobstructedArea(page)
      return Math.max(
        Math.abs(box.x + box.width / 2 - (area.x + area.width / 2)),
        Math.abs(box.y + box.height / 2 - (area.y + area.height / 2))
      )
    })
    .toBeLessThan(3)
}

type HoldGlobal = {
  __canvasHold?: {
    original: (...args: unknown[]) => unknown
    pattern: unknown
    waiting: Array<() => void>
  }
}

// Holds the window's canvas commands that match `pattern` (a partial command, compared field by field) in the
// main process until released, as a slow creation or save would. Other commands run at once.
export async function holdCanvasCommands(app: ElectronApplication, pattern: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ ipcMain }, pattern) => {
    const channel = 'spade:canvas.execute'
    const state = globalThis as unknown as HoldGlobal
    if (!state.__canvasHold) {
      // Electron keeps invoke handlers in this map; the original handler still serves every command.
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
      const hold = { original: handlers.get(channel)!, pattern: null as unknown, waiting: [] as Array<() => void> }
      state.__canvasHold = hold
      const matches = (value: unknown, expected: unknown): boolean =>
        typeof expected === 'object' && expected !== null
          ? typeof value === 'object' &&
            value !== null &&
            Object.entries(expected).every(([key, field]) => matches((value as Record<string, unknown>)[key], field))
          : value === expected
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        if (hold.pattern !== null && matches(args[1], hold.pattern)) await new Promise<void>((release) => hold.waiting.push(release))
        return hold.original(event, ...args)
      })
    }
    state.__canvasHold.pattern = pattern
  }, pattern)
}

// Canvas commands held right now.
export async function heldCanvasCommands(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as unknown as HoldGlobal).__canvasHold?.waiting.length ?? 0)
}

// Lets every held command through and stops holding.
export async function releaseCanvasCommands(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const hold = (globalThis as unknown as HoldGlobal).__canvasHold
    if (!hold) return
    hold.pattern = null
    for (const release of hold.waiting.splice(0)) release()
  })
}

type RecordGlobal = { __canvasCommands?: unknown[] }

// Records every canvas command the window sends from now on; each still runs as usual.
export async function recordCanvasCommands(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const channel = 'spade:canvas.execute'
    const state = globalThis as unknown as RecordGlobal
    if (state.__canvasCommands) return
    const recorded: unknown[] = []
    state.__canvasCommands = recorded
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
    const original = handlers.get(channel)!
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      recorded.push(args[1])
      return original(event, ...args)
    })
  })
}

export async function recordedCanvasCommands(app: ElectronApplication): Promise<CanvasCommand[]> {
  return app.evaluate(() => ((globalThis as unknown as RecordGlobal).__canvasCommands ?? []) as never)
}

type RenderGlobal = { __spadeBodyRenders: Record<string, number> }

// Counts, per node id, the React commits in which that node's entity body rendered, through the hook React
// offers developer tools. Reloads the window so the hook exists before React starts.
export async function countBodyRenders(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const renders: Record<string, number> = {}
    const seen = new Map<string, object>()
    ;(window as unknown as RenderGlobal).__spadeBodyRenders = renders
    type Fiber = { child: Fiber | null; sibling: Fiber | null; type: unknown; flags: number; memoizedProps: unknown }
    // React's PerformedWork flag: the component function ran in this render.
    const PERFORMED_WORK = 1
    const isBody = (props: unknown): props is { node: { id: string } } =>
      typeof props === 'object' && props !== null && 'host' in props && 'detail' in props && 'active' in props && 'node' in props
    const visit = (root: Fiber): void => {
      const stack: Fiber[] = [root]
      while (stack.length > 0) {
        const fiber = stack.pop()!
        if (typeof fiber.type === 'function' && isBody(fiber.memoizedProps)) {
          const id = fiber.memoizedProps.node.id
          if (seen.get(id) !== fiber && (fiber.flags & PERFORMED_WORK) !== 0) renders[id] = (renders[id] ?? 0) + 1
          seen.set(id, fiber)
        }
        if (fiber.sibling) stack.push(fiber.sibling)
        if (fiber.child) stack.push(fiber.child)
      }
    }
    ;(window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      isDisabled: false,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => {},
      onScheduleFiberRoot: () => {},
      onCommitFiberRoot: (_renderer: number, root: { current: Fiber }) => visit(root.current),
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {}
    }
  })
  await page.reload()
  await expect(page.getByTestId('app-shell')).toBeVisible()
}

export async function bodyRenders(page: Page, nodeId: string): Promise<number> {
  return page.evaluate((id) => (window as unknown as RenderGlobal).__spadeBodyRenders[id] ?? 0, nodeId)
}

// Fits every node and waits for React Flow to apply the new viewport. React Flow applies a fit a few frames after
// the click, so an unchanged viewport is only trusted once it has held long enough for a fit to have landed.
export async function fitAll(page: Page): Promise<void> {
  const before = JSON.stringify(await renderedViewport(page))
  await page.getByRole('toolbar', { name: 'Canvas' }).getByRole('button', { name: 'Fit all' }).click()
  let previous = before
  let since = Date.now()
  await expect
    .poll(async () => {
      const current = JSON.stringify(await renderedViewport(page))
      if (current !== previous) {
        previous = current
        since = Date.now()
        return false
      }
      return Date.now() - since >= (current === before ? 300 : 50)
    }, { intervals: [20, 20, 50] })
    .toBe(true)
}
