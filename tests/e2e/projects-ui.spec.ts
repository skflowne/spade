import { readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import {
  appState,
  canvasNode,
  createNoteFromToolbar,
  launch,
  openProjectFromSidebar,
  pickNext,
  projectButton,
  projectList,
  readCanvas,
  renderedViewport,
  scratchDirectory
} from './ui-harness'

let scratch: string

test.beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'spade-projects-ui-'))
})

test.afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

test('switches between two project canvases and restores them, the selection, and the viewport after a relaunch', async () => {
  test.setTimeout(120_000)
  const userData = await scratchDirectory(scratch, 'user-data')
  const alphaRoot = await scratchDirectory(scratch, 'alpha')
  const betaRoot = await scratchDirectory(scratch, 'beta')
  const alphaName = basename(alphaRoot)
  const betaName = basename(betaRoot)

  const first = await launch(userData)
  let alphaViewport: { x: number; y: number; zoom: number }
  try {
    const { app, page } = first
    const empty = page.getByTestId('empty-state')
    await expect(empty).toBeVisible()
    await pickNext(app, alphaRoot)
    await empty.getByRole('button', { name: 'Open project…' }).click()
    await expect(empty).toBeHidden()
    await expect(projectButton(page, alphaName)).toHaveAttribute('aria-current', 'page')
    await expect(projectList(page).getByText(alphaRoot)).toBeVisible()

    await openProjectFromSidebar(first, betaRoot)
    await expect(projectButton(page, betaName)).toHaveAttribute('aria-current', 'page')
    await expect(projectButton(page, alphaName)).not.toHaveAttribute('aria-current', 'page')
    await createNoteFromToolbar(page, { title: 'Beta sketch', body: 'Only in beta' })

    await projectButton(page, alphaName).click()
    await expect(projectButton(page, alphaName)).toHaveAttribute('aria-current', 'page')
    await expect(canvasNode(page, 'Beta sketch')).toHaveCount(0)
    await createNoteFromToolbar(page, { title: 'Alpha plan' })

    // Pan and zoom the alpha canvas with the wheel over empty canvas space.
    const pane = page.getByTestId('canvas')
    const box = (await pane.boundingBox())!
    await page.mouse.move(box.x + 40, box.y + box.height - 40)
    await page.mouse.wheel(0, 300)
    await page.mouse.down()
    await page.mouse.move(box.x + 140, box.y + box.height - 100, { steps: 5 })
    await page.mouse.up()
    alphaViewport = await renderedViewport(page)
    expect(alphaViewport.zoom).toBeLessThan(1)
    await expect
      .poll(async () => (await readCanvas(page)).viewport)
      .toEqual({ x: expect.closeTo(alphaViewport.x, 0), y: expect.closeTo(alphaViewport.y, 0), zoom: expect.closeTo(alphaViewport.zoom, 3) })

    await projectButton(page, betaName).click()
    await expect(canvasNode(page, 'Beta sketch')).toBeVisible()
    await expect(canvasNode(page, 'Alpha plan')).toHaveCount(0)
    await projectButton(page, alphaName).click()
    await expect(canvasNode(page, 'Alpha plan')).toBeVisible()
    expect(await renderedViewport(page)).toEqual({
      x: expect.closeTo(alphaViewport.x, 0),
      y: expect.closeTo(alphaViewport.y, 0),
      zoom: expect.closeTo(alphaViewport.zoom, 3)
    })
  } finally {
    await first.app.close()
  }

  const second = await launch(userData)
  try {
    const { page } = second
    await expect(page.getByTestId('empty-state')).toHaveCount(0)
    await expect(projectButton(page, alphaName)).toHaveAttribute('aria-current', 'page')
    await expect(canvasNode(page, 'Alpha plan')).toBeVisible()
    expect(await renderedViewport(page)).toEqual({
      x: expect.closeTo(alphaViewport.x, 0),
      y: expect.closeTo(alphaViewport.y, 0),
      zoom: expect.closeTo(alphaViewport.zoom, 3)
    })
    await projectButton(page, betaName).click()
    await expect(canvasNode(page, 'Beta sketch')).toBeVisible()
    await expect(canvasNode(page, 'Beta sketch').getByTestId('node-body')).toContainText('Only in beta')
  } finally {
    await second.app.close()
  }

  expect(await readdir(alphaRoot)).toEqual([])
  expect(await readdir(betaRoot)).toEqual([])
})

test('renames a project and removes another without touching its directory', async () => {
  const userData = await scratchDirectory(scratch, 'user-data')
  const alphaRoot = await scratchDirectory(scratch, 'alpha')
  const betaRoot = await scratchDirectory(scratch, 'beta')
  const spade = await launch(userData)
  try {
    const { page } = spade
    await openProjectFromSidebar(spade, alphaRoot)
    await openProjectFromSidebar(spade, betaRoot)
    await createNoteFromToolbar(page, { title: 'Beta note' })

    const alphaActions = page.getByRole('button', { name: `Project actions for ${basename(alphaRoot)}` })
    await alphaActions.click()
    await expect(page.getByRole('menuitem', { name: 'Rename…' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(alphaActions).toBeFocused()
    await alphaActions.click()
    await page.getByRole('menuitem', { name: 'Rename…' }).click()
    const rename = page.getByRole('dialog', { name: 'Rename project' })
    await rename.getByLabel('Name').fill('Framework')
    await rename.getByRole('button', { name: 'Rename' }).click()
    await expect(projectButton(page, 'Framework')).toBeVisible()
    await expect(projectButton(page, basename(alphaRoot))).toHaveCount(0)

    await page.getByRole('button', { name: `Project actions for ${basename(betaRoot)}` }).click()
    await page.getByRole('menuitem', { name: 'Remove…' }).click()
    const confirm = page.getByRole('alertdialog', { name: `Remove ${basename(betaRoot)}?` })
    await expect(confirm).toContainText('The directory is not touched')
    await expect(confirm).toContainText(betaRoot)
    await confirm.getByRole('button', { name: 'Remove project' }).click()
    await expect(confirm).toBeHidden()

    await expect(projectList(page).getByRole('listitem')).toHaveCount(1)
    await expect(projectButton(page, 'Framework')).toHaveAttribute('aria-current', 'page')
    expect((await appState(page)).projects.map((project) => project.name)).toEqual(['Framework'])
  } finally {
    await spade.app.close()
  }

  expect((await stat(betaRoot)).isDirectory()).toBe(true)
  expect(await readdir(alphaRoot)).toEqual([])
  expect(await readdir(betaRoot)).toEqual([])
})
