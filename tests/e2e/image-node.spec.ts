import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import {
  canvasNode,
  execute,
  launch,
  nodeBody,
  nodeHeader,
  nodeMenu,
  openProjectFromSidebar,
  pickNext,
  readCanvas,
  scratchDirectory,
  type Spade
} from './ui-harness'
import { failInMain, menuEntry, noticeAlerts } from './entity-harness'

// A solid-color RGB PNG of the given size.
function png(width: number, height: number, [red, green, blue]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // truecolor
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x += 1) row.set([red, green, blue], 1 + x * 3)
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

let scratch: string

test.beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'spade-image-'))
})

test.afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function launchWithProject(userData: string, project: string): Promise<Spade> {
  const spade = await launch(userData)
  await openProjectFromSidebar(spade, project)
  await expect(spade.page.getByTestId('canvas')).toBeVisible()
  return spade
}

async function openImageForm(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await page.getByRole('toolbar', { name: 'Canvas' }).getByRole('button', { name: 'New node' }).click()
  await page.getByRole('menu', { name: 'New node' }).getByRole('menuitem', { name: 'Image' }).click()
  const dialog = page.getByRole('dialog', { name: 'New image' })
  await expect(dialog).toBeVisible()
  return dialog
}

async function shownSize(page: Page, title: string): Promise<{ url: string; width: number; height: number } | null> {
  return canvasNode(page, title)
    .getByTestId('image-view')
    .evaluate((image: HTMLImageElement) =>
      image.complete && image.naturalWidth > 0 ? { url: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight } : null
    )
    .catch(() => null)
}

async function expectShown(page: Page, title: string, width: number, height: number): Promise<void> {
  await expect
    .poll(async () => {
      const shown = await shownSize(page, title)
      return shown && { scheme: new URL(shown.url).protocol, width: shown.width, height: shown.height }
    })
    .toEqual({ scheme: 'spade-image:', width, height })
  await expect(nodeHeader(page, title).getByText(`${width}×${height}`)).toBeVisible()
}

// Records showItemInFolder calls in the main process instead of opening Explorer.
async function recordReveals(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const calls: string[] = []
    ;(globalThis as Record<string, unknown>).__spadeReveals = calls
    shell.showItemInFolder = (path: string) => void calls.push(path)
  })
}

async function reveals(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as Record<string, unknown>).__spadeReveals as string[])
}

test('an image node shows a picked file, follows it on disk, and keeps its tree when the file is missing', async () => {
  test.setTimeout(90_000)
  const userData = await scratchDirectory(scratch, 'user-data')
  const project = await scratchDirectory(scratch, 'project')
  const file = join(project, 'shot.png')
  await writeFile(file, png(400, 200, [200, 40, 40]))
  const { app, page } = await launchWithProject(userData, project)

  // Picked through the native dialog.
  const dialog = await openImageForm(page)
  await pickNext(app, file)
  await dialog.getByRole('button', { name: 'Choose image…' }).click()
  await expect(dialog.getByLabel('Path', { exact: true })).toHaveValue(file)
  await dialog.getByLabel('Caption', { exact: true }).fill('A red banner')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  await expectShown(page, 'shot.png', 400, 200)
  await expect(canvasNode(page, 'shot.png').getByText('A red banner')).toBeVisible()
  const record = (await readCanvas(page)).nodes.find((node) => node.title === 'shot.png')!
  // Plan §8: longest side 560, aspect ratio kept (the shortest side never below 240).
  expect(record.size).toEqual({ width: 560, height: 280 })
  expect(record.config).toEqual({ source: { kind: 'path', path: file }, caption: 'A red banner' })

  // The file changes on disk: the node shows the new image.
  await writeFile(file, png(300, 300, [40, 200, 40]))
  await expectShown(page, 'shot.png', 300, 300)

  // A child under the image survives the file going missing.
  const child = await execute(page, {
    type: 'spawnChild',
    sourceNodeId: record.id,
    node: { entityType: 'note', config: { body: 'about the image' }, title: 'Notes on shot' },
    origin: 'spawned'
  })
  expect(child.ok).toBe(true)
  await rm(file)
  const problem = canvasNode(page, 'shot.png').getByTestId('image-problem')
  await expect(problem).toContainText('File not found')
  await expect(problem).toContainText(file)
  await expect(problem.getByRole('button', { name: 'Retry' })).toBeVisible()
  await expect(nodeHeader(page, 'shot.png').getByText('Missing')).toBeVisible()
  expect((await readCanvas(page)).nodes.map((node) => node.title).sort()).toEqual(['Notes on shot', 'shot.png'])
  await expect(canvasNode(page, 'Notes on shot')).toBeVisible()

  // The file comes back: the node recovers by itself.
  await writeFile(file, png(200, 100, [40, 40, 200]))
  await expectShown(page, 'shot.png', 200, 100)
  await expect(problem).toHaveCount(0)

  // Reveal selects the file in Explorer.
  await recordReveals(app)
  await nodeMenu(page, 'shot.png', 'Reveal in Explorer')
  await expect.poll(() => reveals(app)).toEqual([file])

  // Full size opens a lightbox at the image's natural size; Escape closes it.
  await nodeMenu(page, 'shot.png', 'Open full size')
  const lightbox = page.getByRole('dialog', { name: 'shot.png' })
  await expect(lightbox).toBeVisible()
  await lightbox.getByRole('button', { name: 'Actual size' }).click()
  await expect
    .poll(() => lightbox.getByRole('img').evaluate((image: HTMLImageElement) => image.getBoundingClientRect().width))
    .toBe(200)
  await page.keyboard.press('Escape')
  await expect(lightbox).toBeHidden()

  await app.close()
  const relaunched = await launch(userData)
  await expectShown(relaunched.page, 'shot.png', 200, 100)
  await expect(canvasNode(relaunched.page, 'Notes on shot')).toBeVisible()
  await relaunched.app.close()
})

test('an image node opens a typed path relative to the project root, even before the file exists', async () => {
  const project = await scratchDirectory(scratch, 'project')
  await mkdir(join(project, 'images'))
  const file = join(project, 'images', 'later.png')
  const { app, page } = await launchWithProject(await scratchDirectory(scratch, 'user-data'), project)

  const dialog = await openImageForm(page)
  await dialog.getByLabel('Path', { exact: true }).fill('images/later.png')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  const problem = canvasNode(page, 'later.png').getByTestId('image-problem')
  await expect(problem).toContainText('File not found')
  const record = (await readCanvas(page)).nodes.find((node) => node.title === 'later.png')!
  expect(record.config).toEqual({ source: { kind: 'path', path: file } })

  // There is nothing to open at full size, and the menu says why.
  const fullSize = await menuEntry(page, 'later.png', 'Open full size')
  await expect(fullSize).toBeDisabled()
  await expect(fullSize).toContainText('file not found')
  await page.keyboard.press('Escape')

  await writeFile(file, png(120, 360, [10, 10, 10]))
  await expectShown(page, 'later.png', 120, 360)

  // The body toolbar (once active) reloads and copies the path.
  await nodeBody(page, 'later.png').click()
  await canvasNode(page, 'later.png').getByRole('button', { name: 'Copy path' }).click()
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(file)

  // A collapsed node has no body: Reload waits for it, and a failed menu action is still reported.
  await nodeMenu(page, 'later.png', 'Collapse node')
  const reload = await menuEntry(page, 'later.png', 'Reload')
  await expect(reload).toBeDisabled()
  await expect(reload).toContainText('node collapsed')
  await page.keyboard.press('Escape')
  await failInMain(app, 'files.reveal', 'Explorer could not be started.')
  await nodeMenu(page, 'later.png', 'Reveal in Explorer')
  await expect(noticeAlerts(page)).toContainText('Explorer could not be started.')
  await app.close()
})

test('an unreadable image file shows an explicit state', async () => {
  const project = await scratchDirectory(scratch, 'project')
  await writeFile(join(project, 'broken.png'), 'not a png at all')
  const { app, page } = await launchWithProject(await scratchDirectory(scratch, 'user-data'), project)

  const dialog = await openImageForm(page)
  await dialog.getByLabel('Path', { exact: true }).fill('broken.png')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  await expect(canvasNode(page, 'broken.png').getByTestId('image-problem')).toContainText('cannot be shown')
  await app.close()
})
