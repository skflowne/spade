import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { indexTree } from '../../src/shared/tree'
import { installAgentScript, setProviders } from './agent-harness'
import {
  canvasNode,
  createNoteFromToolbar,
  execute,
  expectNoNotice,
  fitAll,
  launch,
  nodeBody,
  nodeHeader,
  nodeIdByTitle,
  nodeMenu,
  openProjectFromSidebar,
  readCanvas,
  renderedViewport,
  scratchDirectory,
  type Spade
} from './ui-harness'

let scratch: string

test.beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'spade-canvas-ui-'))
})

test.afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function launchWithProject(userData?: string): Promise<Spade> {
  const spade = await launch(userData ?? (await scratchDirectory(scratch, 'user-data')))
  await openProjectFromSidebar(spade, await scratchDirectory(scratch, 'project'))
  await expect(spade.page.getByTestId('canvas')).toBeVisible()
  return spade
}

async function seedNote(page: Page, title: string, parentTitle?: string): Promise<string> {
  const node = { entityType: 'note', config: { body: `${title} text` }, title }
  const response = parentTitle
    ? await execute(page, { type: 'spawnChild', sourceNodeId: await nodeIdByTitle(page, parentTitle), node, origin: 'spawned' })
    : await execute(page, { type: 'startTree', node })
  if (!response.ok || !response.nodeId) throw new Error(JSON.stringify(response))
  await expect(canvasNode(page, title)).toBeVisible()
  return response.nodeId
}

async function parentTitleOf(page: Page, title: string): Promise<string | null> {
  const canvas = await readCanvas(page)
  const id = canvas.nodes.find((node) => node.title === title)!.id
  const parent = indexTree(canvas).parentOf(id)
  return parent === null ? null : canvas.nodes.find((node) => node.id === parent)!.title
}

async function spawnFrom(
  page: Page,
  sourceTitle: string,
  title: string,
  chooseTarget: (dialog: ReturnType<Page['getByRole']>) => Promise<void> = async () => {}
): Promise<void> {
  await fitAll(page)
  await nodeMenu(page, sourceTitle, 'Spawn connected…')
  const dialog = page.getByRole('dialog', { name: `Spawn from ${sourceTitle}` })
  await dialog.getByRole('radio', { name: 'Note' }).check()
  await dialog.getByLabel('Title', { exact: true }).fill(title)
  await chooseTarget(dialog)
  await page.getByRole('dialog', { name: `Spawn from ${sourceTitle}` }).getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  await expect(canvasNode(page, title)).toBeVisible()
}

type Box = { x: number; y: number; width: number; height: number }

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

async function screenCenterOf(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId('canvas').boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test('spawns nodes with every target choice, readable and without overlap, and never moves a node the user placed', async () => {
  test.setTimeout(120_000)
  const spade = await launchWithProject()
  const { page } = spade
  try {
    await createNoteFromToolbar(page, { title: 'Root A', body: 'The first tree' })

    // A user-initiated spawn centers the new node at 100%.
    await spawnFrom(page, 'Root A', 'Child 1')
    expect(await parentTitleOf(page, 'Child 1')).toBe('Root A')
    expect((await renderedViewport(page)).zoom).toBeCloseTo(1, 3)
    const childBox = (await canvasNode(page, 'Child 1').boundingBox())!
    const center = await screenCenterOf(page)
    expect(Math.abs(childBox.x + childBox.width / 2 - center.x)).toBeLessThan(2)
    expect(Math.abs(childBox.y + childBox.height / 2 - center.y)).toBeLessThan(2)

    // Pick a node on the canvas.
    await spawnFrom(page, 'Child 1', 'Child 2', async (dialog) => {
      await dialog.getByRole('radio', { name: 'Pick a tree or node' }).check()
      await dialog.getByRole('button', { name: 'Pick on canvas' }).click()
      await expect(dialog).toBeHidden()
      await expect(page.getByTestId('picking-banner')).toBeVisible()
      await fitAll(page)
      await nodeHeader(page, 'Root A').click()
      await expect(page.getByTestId('picking-banner')).toBeHidden()
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('treeitem', { name: 'Root A', exact: true })).toHaveAttribute('aria-selected', 'true')
    })
    expect(await parentTitleOf(page, 'Child 2')).toBe('Root A')

    await spawnFrom(page, 'Child 2', 'Root B', async (dialog) => {
      await dialog.getByRole('radio', { name: 'Start a new tree' }).check()
    })
    expect(await parentTitleOf(page, 'Root B')).toBeNull()

    // Choose from the tree list and attach to that tree's root.
    await spawnFrom(page, 'Root B', 'Child 3', async (dialog) => {
      await dialog.getByRole('radio', { name: 'Pick a tree or node' }).check()
      await dialog.getByRole('treeitem', { name: 'Child 1', exact: true }).click()
      await dialog.getByRole('radio', { name: "Attach to its tree's root" }).check()
    })
    expect(await parentTitleOf(page, 'Child 3')).toBe('Root A')

    // Escape cancels picking and returns to the dialog.
    await fitAll(page)
    await nodeMenu(page, 'Root B', 'Spawn connected…')
    const dialog = page.getByRole('dialog', { name: 'Spawn from Root B' })
    await dialog.getByRole('radio', { name: 'Pick a tree or node' }).check()
    await dialog.getByRole('button', { name: 'Pick on canvas' }).click()
    await expect(page.getByTestId('picking-banner')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('picking-banner')).toBeHidden()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    await spawnFrom(page, 'Root B', 'Child B1')
    await spawnFrom(page, 'Child 1', 'Grandchild 1')
    for (const [source, title] of [
      ['Child 2', 'Extra 1'],
      ['Child 2', 'Extra 2'],
      ['Child 2', 'Extra 3'],
      ['Grandchild 1', 'Extra 4'],
      ['Grandchild 1', 'Extra 5'],
      ['Child 3', 'Extra 6'],
      ['Child B1', 'Extra 7']
    ]) {
      await spawnFrom(page, source, title)
    }
    await createNoteFromToolbar(page, { title: 'Root C' })
    for (const title of ['Extra 8', 'Extra 9', 'Extra 10']) await spawnFrom(page, 'Root C', title)

    // Every node is readable at 100% and no two rendered nodes overlap.
    await page.getByRole('button', { name: 'Zoom to 100%' }).click()
    expect((await renderedViewport(page)).zoom).toBeCloseTo(1, 3)
    const titles = (await readCanvas(page)).nodes.map((node) => node.title)
    expect(titles).toHaveLength(18)
    const boxes: Box[] = []
    for (const title of titles) {
      const box = (await canvasNode(page, title).boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(319)
      expect(box.height).toBeGreaterThanOrEqual(199)
      boxes.push(box)
    }
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        expect(overlaps(boxes[i], boxes[j]), `${titles[i]} overlaps ${titles[j]}`).toBe(false)
      }
    }

    // Dragging by the header moves the node; dragging by the body does not.
    // Fit centers the node, far from the edges where a drag auto-pans the canvas.
    await fitAll(page)
    await nodeMenu(page, 'Child B1', 'Fit')
    const before = (await readCanvas(page)).nodes.find((node) => node.title === 'Child B1')!.position
    const zoom = (await renderedViewport(page)).zoom
    const header = (await nodeHeader(page, 'Child B1').boundingBox())!
    // Toward the middle of the canvas, away from the edges where a drag auto-pans.
    const offset = header.y > (await screenCenterOf(page)).y ? -120 : 120
    await page.mouse.move(header.x + 30, header.y + header.height / 2)
    await page.mouse.down()
    await page.mouse.move(header.x + 30, header.y + header.height / 2 + offset / 2, { steps: 8 })
    await page.mouse.move(header.x + 30, header.y + header.height / 2 + offset, { steps: 8 })
    await page.mouse.up()
    // Within a few screen pixels of the pointer's travel.
    await expect
      .poll(async () => {
        const y = (await readCanvas(page)).nodes.find((node) => node.title === 'Child B1')!.position.y
        return Math.abs((y - before.y) * zoom - offset)
      })
      .toBeLessThan(8)
    const moved = (await readCanvas(page)).nodes.find((node) => node.title === 'Child B1')!.position

    await fitAll(page)
    const body = (await nodeBody(page, 'Child 2').boundingBox())!
    const child2Before = (await readCanvas(page)).nodes.find((node) => node.title === 'Child 2')!.position
    await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2)
    await page.mouse.down()
    await page.mouse.move(body.x + body.width / 2 + 60, body.y + body.height / 2 + 120, { steps: 8 })
    await page.mouse.up()
    expect((await readCanvas(page)).nodes.find((node) => node.title === 'Child 2')!.position).toEqual(child2Before)

    // Later spawns never reposition the moved node.
    await spawnFrom(page, 'Root B', 'Child B2')
    await spawnFrom(page, 'Root B', 'Child B3')
    expect((await readCanvas(page)).nodes.find((node) => node.title === 'Child B1')!.position).toEqual(moved)

    // Alt+drag on the header moves the whole branch; nodes outside it stay put.
    await fitAll(page)
    const positions = async (): Promise<Map<string, { x: number; y: number }>> =>
      new Map((await readCanvas(page)).nodes.map((node) => [node.title, node.position]))
    const start = await positions()
    const rootB = (await nodeHeader(page, 'Root B').boundingBox())!
    const step = rootB.x > (await screenCenterOf(page)).x ? -100 : 100
    await page.keyboard.down('Alt')
    await page.mouse.move(rootB.x + 30, rootB.y + rootB.height / 2)
    await page.mouse.down()
    await page.mouse.move(rootB.x + 30 + step / 2, rootB.y + rootB.height / 2, { steps: 6 })
    await page.mouse.move(rootB.x + 30 + step, rootB.y + rootB.height / 2, { steps: 6 })
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await expect.poll(async () => (await positions()).get('Root B')!.x).not.toBe(start.get('Root B')!.x)
    const end = await positions()
    const dx = end.get('Root B')!.x - start.get('Root B')!.x
    for (const title of ['Child B1', 'Child B2', 'Child B3']) {
      expect(end.get(title)).toEqual({ x: start.get(title)!.x + dx, y: start.get(title)!.y })
    }
    for (const title of ['Root A', 'Child 1', 'Child 2', 'Child 3', 'Grandchild 1']) {
      expect(end.get(title)).toEqual(start.get(title))
    }
    await expectNoNotice(page)
  } finally {
    await spade.app.close()
  }
})

test('carries a whole branch through an Alt+drag even when a node in it changes mid-drag', async () => {
  const spade = await launchWithProject()
  const { page } = spade
  try {
    const trunkId = await seedNote(page, 'Trunk')
    await execute(page, {
      type: 'spawnChild',
      sourceNodeId: trunkId,
      node: { entityType: 'note', config: { body: '' }, title: 'Twig', position: { x: 0, y: 400 } },
      origin: 'spawned'
    })
    await expect(canvasNode(page, 'Twig')).toBeVisible()
    await execute(page, { type: 'moveNodes', moves: [{ nodeId: trunkId, position: { x: 0, y: 0 } }] })
    await fitAll(page)
    await expect(page.locator('.spade-edge--child path.react-flow__edge-path')).toHaveAttribute('marker-end', /url/)

    const twigBefore = (await canvasNode(page, 'Twig').boundingBox())!
    const trunk = (await nodeHeader(page, 'Trunk').boundingBox())!
    const start = { x: trunk.x + 30, y: trunk.y + trunk.height / 2 }
    await page.keyboard.down('Alt')
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 60, start.y, { steps: 6 })
    await page.mouse.move(start.x + 120, start.y, { steps: 6 })

    // Something else (an agent, another window) changes the carried node while the drag is in progress.
    await execute(page, { type: 'updateNode', nodeId: await nodeIdByTitle(page, 'Twig'), patch: { title: 'Twig renamed' } })
    await expect(canvasNode(page, 'Twig renamed')).toBeVisible()
    await page.waitForTimeout(100)
    const carried = (await canvasNode(page, 'Twig renamed').boundingBox())!
    expect(carried.x - twigBefore.x).toBeGreaterThan(100)

    await page.mouse.move(start.x + 130, start.y, { steps: 2 })
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await expect
      .poll(async () => (await readCanvas(page)).nodes.map((node) => node.position.x))
      .toEqual([expect.any(Number), expect.any(Number)])
    const [trunkRecord, twigRecord] = (await readCanvas(page)).nodes
    expect(trunkRecord.position.x).toBeGreaterThan(0)
    expect(twigRecord.position.x).toBe(trunkRecord.position.x)
    await expectNoNotice(page)
  } finally {
    await spade.app.close()
  }
})

test('zooms the canvas over chrome and inactive bodies, and gives an activated body its own input', async () => {
  const spade = await launchWithProject()
  const { page } = spade
  try {
    await createNoteFromToolbar(page, { title: 'Scratch', body: 'Draft' })
    const body = nodeBody(page, 'Scratch')

    const zoomBefore = (await renderedViewport(page)).zoom
    const header = (await nodeHeader(page, 'Scratch').boundingBox())!
    await page.mouse.move(header.x + 40, header.y + header.height / 2)
    await page.mouse.wheel(0, 200)
    await expect.poll(async () => (await renderedViewport(page)).zoom).toBeLessThan(zoomBefore)

    const zoomOverHeader = (await renderedViewport(page)).zoom
    let box = (await body.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -200)
    await expect.poll(async () => (await renderedViewport(page)).zoom).toBeGreaterThan(zoomOverHeader)
    await expect(body).toHaveAttribute('data-active', 'false')

    box = (await body.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(body).toHaveAttribute('data-active', 'true')
    await expect(body).toHaveClass(/nowheel/)
    const zoomActive = (await renderedViewport(page)).zoom
    await page.mouse.wheel(0, 200)
    await page.waitForTimeout(200)
    expect((await renderedViewport(page)).zoom).toBe(zoomActive)

    const text = body.getByRole('textbox', { name: 'Note text' })
    await expect(text).toBeFocused()
    await text.fill('Edited in place')
    await page.keyboard.press('Escape')
    await expect(body).toHaveAttribute('data-active', 'false')
    await expect
      .poll(async () => (await readCanvas(page)).nodes.find((node) => node.title === 'Scratch')!.config)
      .toEqual({ body: 'Edited in place' })

    await body.click()
    await expect(body).toHaveAttribute('data-active', 'true')
    await nodeHeader(page, 'Scratch').click({ position: { x: 60, y: 10 } })
    await expect(body).toHaveAttribute('data-active', 'false')
  } finally {
    await spade.app.close()
  }
})

test('reparents, collapses, renames and removes through node chrome, surfacing a rejected cycle', async () => {
  test.setTimeout(90_000)
  const spade = await launchWithProject()
  const { page } = spade
  try {
    await seedNote(page, 'Root')
    await seedNote(page, 'Middle', 'Root')
    await seedNote(page, 'Leaf', 'Middle')
    await seedNote(page, 'Loose')
    await fitAll(page)

    // Move to… a picked node.
    await nodeMenu(page, 'Loose', 'Move to…')
    let move = page.getByRole('dialog', { name: 'Move Loose' })
    await move.getByRole('treeitem', { name: 'Leaf', exact: true }).click()
    await move.getByRole('button', { name: 'Move' }).click()
    await expect(move).toBeHidden()
    await expect.poll(() => parentTitleOf(page, 'Loose')).toBe('Leaf')

    // A cycle is rejected by the main process and shown as a dismissible error.
    await nodeMenu(page, 'Root', 'Move to…')
    move = page.getByRole('dialog', { name: 'Move Root' })
    await move.getByRole('treeitem', { name: 'Leaf', exact: true }).click()
    await move.getByRole('button', { name: 'Move' }).click()
    const notice = page.getByRole('region', { name: 'Notices' }).getByRole('alert')
    await expect(notice).toContainText(/cycle|descendant/i)
    await notice.getByRole('button', { name: 'Dismiss' }).click()
    await expectNoNotice(page)
    expect(await parentTitleOf(page, 'Root')).toBeNull()

    // Make root.
    await nodeMenu(page, 'Loose', 'Move to…')
    move = page.getByRole('dialog', { name: 'Move Loose' })
    await move.getByRole('radio', { name: 'Make it a root' }).check()
    await move.getByRole('button', { name: 'Move' }).click()
    await expect.poll(() => parentTitleOf(page, 'Loose')).toBeNull()

    // Collapse and expand the branch.
    await canvasNode(page, 'Root').getByRole('button', { name: 'Collapse branch' }).click()
    await expect(canvasNode(page, 'Middle')).toHaveCount(0)
    await expect(canvasNode(page, 'Leaf')).toHaveCount(0)
    const expandBranch = canvasNode(page, 'Root').getByRole('button', { name: 'Expand branch (2 hidden)' })
    await expect(expandBranch).toBeVisible()
    await expandBranch.click()
    await expect(canvasNode(page, 'Leaf')).toBeVisible()

    // Collapse a single node to its header.
    await canvasNode(page, 'Leaf').getByRole('button', { name: 'Collapse node' }).click()
    await expect(nodeBody(page, 'Leaf')).toHaveCount(0)
    const zoom = (await renderedViewport(page)).zoom
    const collapsed = (await canvasNode(page, 'Leaf').boundingBox())!
    expect(collapsed.height / zoom).toBeCloseTo(96, 0)
    await canvasNode(page, 'Leaf').getByRole('button', { name: 'Expand node' }).click()
    await expect(nodeBody(page, 'Leaf')).toBeVisible()

    // Inline rename.
    await canvasNode(page, 'Leaf').getByRole('heading', { name: 'Leaf' }).dblclick()
    const titleInput = page.getByRole('textbox', { name: 'Node title' })
    await titleInput.fill('Renamed leaf')
    await titleInput.press('Enter')
    await expect(canvasNode(page, 'Renamed leaf')).toBeVisible()
    expect((await readCanvas(page)).nodes.map((node) => node.title)).toContain('Renamed leaf')

    // Removing a node promotes its children.
    await nodeMenu(page, 'Middle', 'Remove node…')
    let confirm = page.getByRole('alertdialog', { name: 'Remove Middle?' })
    await expect(confirm).toContainText('Its 1 child moves up to Root')
    await expect(confirm).toContainText('Nothing on disk or in Paseo is deleted')
    await confirm.getByRole('button', { name: 'Remove node' }).click()
    await expect(canvasNode(page, 'Middle')).toHaveCount(0)
    expect(await parentTitleOf(page, 'Renamed leaf')).toBe('Root')

    // Removing a branch removes the node and every descendant.
    await nodeMenu(page, 'Root', 'Remove branch…')
    confirm = page.getByRole('alertdialog', { name: 'Remove the branch Root?' })
    await expect(confirm).toContainText('2 nodes')
    await confirm.getByRole('button', { name: 'Remove branch' }).click()
    await expect(canvasNode(page, 'Root')).toHaveCount(0)
    await expect(canvasNode(page, 'Renamed leaf')).toHaveCount(0)
    expect((await readCanvas(page)).nodes.map((node) => node.title)).toEqual(['Loose'])
  } finally {
    await spade.app.close()
  }
})

test('keeps a resized node across a relaunch and shows external commands without moving the viewport', async () => {
  test.setTimeout(90_000)
  const userData = await scratchDirectory(scratch, 'user-data')
  const first = await launchWithProject(userData)
  try {
    const { page } = first
    await createNoteFromToolbar(page, { title: 'Sized' })
    await page.getByRole('button', { name: 'Zoom to 100%' }).click()
    const node = canvasNode(page, 'Sized')
    await node.hover()
    const handle = page.locator('.react-flow__resize-control.bottom.right')
    const grip = (await handle.boundingBox())!
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
    await page.mouse.down()
    await page.mouse.move(grip.x + grip.width / 2 + 100, grip.y + grip.height / 2 + 60, { steps: 10 })
    await page.mouse.up()
    await expect
      .poll(async () => (await readCanvas(page)).nodes[0].size)
      .toEqual({ width: expect.closeTo(420, -1), height: expect.closeTo(260, -1) })

    const viewport = await renderedViewport(page)
    const response = await execute(page, {
      type: 'startTree',
      node: { entityType: 'note', config: { body: 'from outside' }, title: 'External' }
    })
    expect(response.ok).toBe(true)
    await expect(canvasNode(page, 'External')).toHaveCount(1)
    await page.waitForTimeout(300)
    expect(await renderedViewport(page)).toEqual(viewport)
  } finally {
    await first.app.close()
  }

  const second = await launch(userData)
  try {
    const { page } = second
    const size = (await readCanvas(page)).nodes.find((node) => node.title === 'Sized')!.size!
    await expect(canvasNode(page, 'Sized')).toBeVisible()
    const zoom = (await renderedViewport(page)).zoom
    const box = (await canvasNode(page, 'Sized').boundingBox())!
    expect(box.width / zoom).toBeCloseTo(size.width, 0)
    expect(box.height / zoom).toBeCloseTo(size.height, 0)
  } finally {
    await second.app.close()
  }
})

test('shows a failed creation in the dialog and as a dismissible notice', async () => {
  const spade = await launchWithProject()
  const { page } = spade
  try {
    // Paseo lists a provider, then cannot spawn: UI specs run with Paseo disabled in the main process.
    await installAgentScript(spade.app)
    await setProviders(spade.app, {
      providers: [
        { id: 'claude', label: 'Claude', available: true, status: 'ready', error: null, models: [], modes: [], defaultModeId: null }
      ]
    })
    await page.getByRole('toolbar', { name: 'Canvas' }).getByRole('button', { name: 'New node' }).click()
    await page.getByRole('menu', { name: 'New node' }).getByRole('menuitem', { name: 'Agent' }).click()
    const dialog = page.getByRole('dialog', { name: 'New agent' })
    await expect(dialog.getByLabel('Provider', { exact: true })).toHaveValue('claude')
    await dialog.getByLabel('Prompt', { exact: true }).fill('Plan the work')
    await dialog.getByRole('button', { name: 'Create' }).click()
    await expect(dialog.getByRole('alert')).toContainText('Could not create the agent')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    const notice = page.getByRole('region', { name: 'Notices' }).getByRole('alert')
    await expect(notice).toContainText('Could not create the agent')
    await notice.getByRole('button', { name: 'Dismiss' }).click()
    await expectNoNotice(page)
    expect((await readCanvas(page)).nodes).toEqual([])
  } finally {
    await spade.app.close()
  }
})
