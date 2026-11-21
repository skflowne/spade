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

// Fits every node and waits for React Flow to apply the new viewport.
export async function fitAll(page: Page): Promise<void> {
  await page.getByRole('toolbar', { name: 'Canvas' }).getByRole('button', { name: 'Fit all' }).click()
  let previous = JSON.stringify(await renderedViewport(page))
  await expect
    .poll(async () => {
      const current = JSON.stringify(await renderedViewport(page))
      const stable = current === previous
      previous = current
      return stable
    }, { intervals: [50, 50, 100] })
    .toBe(true)
}
