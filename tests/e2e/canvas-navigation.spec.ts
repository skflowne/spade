import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { NodeSeed } from '../../src/shared/commands'
import {
  canvasNode,
  execute,
  expectNoNotice,
  fitAll,
  launch,
  nodeBody,
  nodeHeader,
  nodeIdByTitle,
  nodeMenu,
  openProjectFromSidebar,
  projectButton,
  readCanvas,
  renderedViewport,
  scratchDirectory,
  appState,
  type Spade
} from './ui-harness'

let scratch: string

test.beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'spade-canvas-nav-'))
})

test.afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

type Launched = Spade & { userData: string; projectDirectory: string }

async function launchWithProject(): Promise<Launched> {
  const userData = await scratchDirectory(scratch, 'user-data')
  const projectDirectory = await scratchDirectory(scratch, 'project')
  const spade = await launch(userData)
  await openProjectFromSidebar(spade, projectDirectory)
  await expect(spade.page.getByTestId('canvas')).toBeVisible()
  return { ...spade, userData, projectDirectory }
}

async function seed(page: Page, title: string, options: { parent?: string; seed?: Partial<NodeSeed> } = {}): Promise<string> {
  const node: NodeSeed = { entityType: 'note', config: { body: `${title} text` }, title, ...options.seed }
  const response = options.parent
    ? await execute(page, { type: 'spawnChild', sourceNodeId: await nodeIdByTitle(page, options.parent), node, origin: 'spawned' })
    : await execute(page, { type: 'startTree', node })
  if (!response.ok || !response.nodeId) throw new Error(JSON.stringify(response))
  return response.nodeId
}

const toolbar = (page: Page): Locator => page.getByRole('toolbar', { name: 'Canvas' })
const breadcrumb = (page: Page): Locator => page.getByRole('navigation', { name: 'Current focus' })
const currentFocus = (page: Page): Locator => breadcrumb(page).locator('[aria-current="location"]')
const sidePanel = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true })
const searchInput = (page: Page): Locator => page.getByRole('combobox', { name: 'Search nodes' })

async function expectCentered(page: Page, title: string): Promise<void> {
  await expect
    .poll(async () => {
      const node = await canvasNode(page, title).boundingBox()
      const pane = await page.getByTestId('canvas').boundingBox()
      if (!node || !pane) return Number.POSITIVE_INFINITY
      return Math.max(
        Math.abs(node.x + node.width / 2 - (pane.x + pane.width / 2)),
        Math.abs(node.y + node.height / 2 - (pane.y + pane.height / 2))
      )
    })
    .toBeLessThan(3)
}

async function relatedMenu(page: Page, title: string, item: string | RegExp): Promise<void> {
  await canvasNode(page, title).getByTestId('related-nodes').click()
  await page.getByRole('menu', { name: `Related to ${title}` }).getByRole('menuitem', { name: item }).click()
}

async function controlCall(userData: string, method: string, params: unknown, agentId: string): Promise<{ ok: boolean }> {
  const file = join(userData, 'data', 'control.json')
  await expect.poll(async () => readFile(file, 'utf8').then(() => true, () => false)).toBe(true)
  const info = JSON.parse(await readFile(file, 'utf8')) as { url: string; token: string }
  const response = await fetch(new URL('/rpc', info.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
    body: JSON.stringify({ method, params, agentId })
  })
  return (await response.json()) as { ok: boolean }
}

const agentSeed = (agentId: string): Partial<NodeSeed> => ({
  entityType: 'agent',
  config: { provider: 'claude', model: null, mode: null, prompt: null },
  resourceRef: { provider: 'paseo', kind: 'agent', id: agentId }
})

test('restores archived nodes from the archived panel, undoes an archive, and keeps orphaned children reachable', async () => {
  test.setTimeout(90_000)
  const spade = await launchWithProject()
  const { page } = spade
  try {
    await seed(page, 'Root')
    await seed(page, 'Middle', { parent: 'Root' })
    await seed(page, 'Leaf', { parent: 'Middle' })
    await seed(page, 'Loose')
    await fitAll(page)
    await expect(page.locator('.react-flow__edge')).toHaveCount(2)

    // Archiving one node hides it; its child stays, flagged, with no edge to the hidden parent.
    await nodeMenu(page, 'Middle', 'Archive node')
    await expect(canvasNode(page, 'Middle')).toHaveCount(0)
    await expect(canvasNode(page, 'Leaf').getByTestId('parent-archived')).toBeVisible()
    await expect(page.locator('.react-flow__edge')).toHaveCount(0)

    // The confirmation undoes it.
    const notice = page.getByRole('region', { name: 'Notices' }).getByRole('status').filter({ hasText: 'Archived “Middle”' })
    await notice.getByRole('button', { name: 'Undo' }).click()
    await expect(canvasNode(page, 'Middle')).toBeVisible()
    await expect(canvasNode(page, 'Leaf').getByTestId('parent-archived')).toHaveCount(0)
    await expect(page.locator('.react-flow__edge')).toHaveCount(2)

    // A whole branch comes back from the panel in one step.
    await nodeMenu(page, 'Root', 'Archive branch')
    for (const title of ['Root', 'Middle', 'Leaf']) await expect(canvasNode(page, title)).toHaveCount(0)
    await toolbar(page).getByRole('button', { name: 'Archived 1' }).click()
    const panel = sidePanel(page, 'Archived nodes')
    const rootEntry = panel.getByTestId('archived-entry').filter({ hasText: 'Root' })
    await expect(rootEntry).toContainText('Note')
    await expect(rootEntry).toContainText('3 nodes in branch')
    await rootEntry.getByRole('button', { name: 'Restore branch Root' }).click()
    for (const title of ['Root', 'Middle', 'Leaf']) await expect(canvasNode(page, title)).toBeVisible()
    await expect(panel.getByTestId('archived-entry')).toHaveCount(0)

    // Undoing a branch archive restores what it archived, not a descendant archived earlier.
    await page.getByRole('button', { name: 'Close Archived nodes' }).click()
    await nodeMenu(page, 'Leaf', 'Archive node')
    await nodeMenu(page, 'Root', 'Archive branch')
    const branchNotice = page.getByRole('region', { name: 'Notices' }).getByRole('status').filter({ hasText: 'Archived the branch' }).last()
    await expect(branchNotice).toContainText('(2 nodes)')
    await branchNotice.getByRole('button', { name: 'Undo' }).click()
    for (const title of ['Root', 'Middle']) await expect(canvasNode(page, title)).toBeVisible()
    await expect(canvasNode(page, 'Leaf')).toHaveCount(0)
    expect((await readCanvas(page)).nodes.find((node) => node.title === 'Leaf')!.archived).toBe(true)
    await toolbar(page).getByRole('button', { name: 'Archived 1' }).click()
    await panel.getByTestId('archived-entry').filter({ hasText: 'Leaf' }).getByRole('button', { name: 'Restore Leaf' }).click()
    await expect(canvasNode(page, 'Leaf')).toBeVisible()

    // The orphan hint leads to the archived parent's entry.
    await nodeMenu(page, 'Middle', 'Archive node')
    await page.getByRole('button', { name: 'Close Archived nodes' }).click()
    await canvasNode(page, 'Leaf').getByTestId('parent-archived').click()
    const middleEntry = panel.getByTestId('archived-entry').filter({ hasText: 'Middle' })
    await expect(middleEntry).toHaveClass(/archived-entry--highlighted/)
    await expect(middleEntry.getByRole('button', { name: 'Restore Middle' })).toBeFocused()
    await middleEntry.getByRole('button', { name: 'Restore Middle' }).click()
    await expect(canvasNode(page, 'Middle')).toBeVisible()

    // Removing from the panel removes the record.
    await nodeMenu(page, 'Loose', 'Archive node')
    const looseEntry = panel.getByTestId('archived-entry').filter({ hasText: 'Loose' })
    await looseEntry.getByRole('button', { name: 'More actions for Loose' }).click()
    await page.getByRole('menu', { name: 'Archived Loose' }).getByRole('menuitem', { name: 'Remove node…' }).click()
    await page.getByRole('alertdialog', { name: 'Remove Loose?' }).getByRole('button', { name: 'Remove node' }).click()
    await expect(looseEntry).toHaveCount(0)
    expect((await readCanvas(page)).nodes.map((node) => node.title)).not.toContain('Loose')
    await expectNoNotice(page)
  } finally {
    await spade.app.close()
  }
})

test('shows who changed what, attributing and marking an agent change made through the control server', async () => {
  test.setTimeout(90_000)
  const spade = await launchWithProject()
  const { page, userData } = spade
  try {
    await seed(page, 'Lead agent', { seed: agentSeed('agent-lead') })
    await seed(page, 'Draft')
    await seed(page, 'Scratch')
    await execute(page, { type: 'removeNode', nodeId: await nodeIdByTitle(page, 'Scratch') })
    await fitAll(page)

    const reply = await controlCall(
      userData,
      'execute',
      { command: { type: 'updateNode', nodeId: await nodeIdByTitle(page, 'Draft'), patch: { title: 'Draft v2' } } },
      'agent-lead'
    )
    expect(reply.ok).toBe(true)

    // The changed node says which agent changed it.
    await expect(canvasNode(page, 'Draft v2').getByTestId('agent-change-marker')).toHaveText('Changed by Lead agent')
    await expect(canvasNode(page, 'Lead agent').getByTestId('agent-change-marker')).toHaveCount(0)

    await toolbar(page).getByRole('button', { name: 'Activity' }).click()
    const panel = sidePanel(page, 'Activity')
    const entries = panel.getByTestId('activity-entry')
    await expect(entries.first()).toHaveAttribute('data-actor', 'agent')
    await expect(entries.first().getByTestId('activity-actor')).toHaveText(/A\s*Lead agent/)
    await expect(entries.first()).toContainText('Renamed')
    await expect(entries.first()).toContainText('just now')
    await expect(entries.nth(1)).toHaveAttribute('data-actor', 'user')
    await expect(entries.nth(1).getByTestId('activity-actor')).toHaveText('You')
    // Nothing the entry touched still exists.
    await expect(entries.filter({ hasText: 'Removed' })).toBeDisabled()

    await panel.getByRole('checkbox', { name: 'Agents only' }).check()
    await expect(entries).toHaveCount(1)
    await panel.getByRole('checkbox', { name: 'Agents only' }).uncheck()

    // An entry leads to the node it changed.
    await page.getByRole('button', { name: 'Zoom to 100%' }).click()
    await entries.first().click()
    await expectCentered(page, 'Draft v2')
    await expect(currentFocus(page)).toHaveText(/Draft v2/)
  } finally {
    await spade.app.close()
  }
})

test('searches by title, type and agent status with the keyboard, and opens the collapsed branch it jumps into', async () => {
  test.setTimeout(90_000)
  const spade = await launchWithProject()
  const { page } = spade
  try {
    await seed(page, 'Root')
    await seed(page, 'Branch', { parent: 'Root' })
    await seed(page, 'Needle', { parent: 'Branch' })
    await seed(page, 'Hidden gem')
    await seed(page, 'Helper', { seed: agentSeed('agent-helper') })
    await fitAll(page)
    await execute(page, { type: 'archiveNode', nodeId: await nodeIdByTitle(page, 'Hidden gem') })
    await canvasNode(page, 'Root').getByRole('button', { name: 'Collapse branch' }).click()
    await expect(canvasNode(page, 'Needle')).toHaveCount(0)

    await page.getByTestId('canvas').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Control+k')
    await expect(searchInput(page)).toBeFocused()
    await page.keyboard.type('needle')
    const results = page.getByRole('listbox', { name: 'Search results' })
    await expect(results.getByRole('option')).toHaveCount(1)
    await expect(results.getByRole('option').first()).toContainText('in a collapsed branch')
    await page.keyboard.press('Enter')
    await expect(canvasNode(page, 'Needle')).toBeVisible()
    await expectCentered(page, 'Needle')
    await expect(breadcrumb(page)).toHaveText(/Root.*Branch.*Needle/)
    await expect(nodeHeader(page, 'Needle')).toBeFocused()

    // Type, and archived nodes left out.
    await page.keyboard.press('Control+f')
    await searchInput(page).fill('agent')
    await expect(results.getByRole('option')).toHaveText([/Helper/])
    await searchInput(page).fill('gem')
    await expect(results.getByRole('option')).toHaveCount(0)
    await expect(results).toContainText('No node matches')

    // Arrow keys choose among several results.
    await searchInput(page).fill('e')
    await expect(results.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowDown')
    await expect(results.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Escape')
    await expect(results).toBeHidden()
  } finally {
    await spade.app.close()
  }
})

test('moves back and forward through explicit focus moves, shown as the path from the root', async () => {
  test.setTimeout(90_000)
  const spade = await launchWithProject()
  const { page } = spade
  try {
    await seed(page, 'Root')
    await seed(page, 'Alpha', { parent: 'Root' })
    await seed(page, 'Beta', { parent: 'Alpha' })
    await seed(page, 'Gamma')
    await fitAll(page)
    await expect(toolbar(page).getByRole('button', { name: 'Back' })).toBeDisabled()

    await searchInput(page).fill('Beta')
    await page.keyboard.press('Enter')
    await expect(breadcrumb(page)).toHaveText(/Root.*Alpha.*Beta/)
    await expect(currentFocus(page)).toHaveText(/Beta/)

    // A breadcrumb segment is a focus move.
    await breadcrumb(page).getByRole('button', { name: 'Root' }).click()
    await expectCentered(page, 'Root')
    await expect(currentFocus(page)).toHaveText(/Root/)

    await searchInput(page).fill('Gamma')
    await page.keyboard.press('Enter')
    await expectCentered(page, 'Gamma')

    // The minimap moves the viewport without becoming a history entry.
    await page.getByRole('img', { name: 'Minimap' }).click({ position: { x: 20, y: 20 } })
    await toolbar(page).getByRole('button', { name: 'Back' }).click()
    await expectCentered(page, 'Root')
    await page.keyboard.press('Alt+ArrowLeft')
    await expectCentered(page, 'Beta')
    await expect(toolbar(page).getByRole('button', { name: 'Back' })).toBeDisabled()
    await page.keyboard.press('Alt+ArrowRight')
    await expectCentered(page, 'Root')
    await toolbar(page).getByRole('button', { name: 'Forward' }).click()
    await expectCentered(page, 'Gamma')
    await expect(toolbar(page).getByRole('button', { name: 'Forward' })).toBeDisabled()

    // A node that was archived is skipped.
    await execute(page, { type: 'archiveNode', nodeId: await nodeIdByTitle(page, 'Root') })
    await toolbar(page).getByRole('button', { name: 'Back' }).click()
    await expectCentered(page, 'Beta')
  } finally {
    await spade.app.close()
  }
})

test('follows edges from node chrome, steps between related nodes by keyboard, and reaches bodies by keyboard', async () => {
  test.setTimeout(90_000)
  const spade = await launchWithProject()
  const { page } = spade
  try {
    await seed(page, 'Root')
    await seed(page, 'First', { parent: 'Root' })
    await seed(page, 'Second', { parent: 'Root' })
    await seed(page, 'Grandchild', { parent: 'First' })
    await fitAll(page)
    await page.getByRole('button', { name: 'Zoom to 100%' }).click()

    await relatedMenu(page, 'Grandchild', /First/)
    await expectCentered(page, 'First')
    await relatedMenu(page, 'First', /Root/)
    await expectCentered(page, 'Root')
    const menu = async (): Promise<Locator> => {
      await canvasNode(page, 'Root').getByTestId('related-nodes').click()
      return page.getByRole('menu', { name: 'Related to Root' })
    }
    const rootMenu = await menu()
    await expect(rootMenu.getByRole('menuitem')).toContainText(['None: this node is a root', 'First', 'Second', 'Connect existing…'])
    await rootMenu.getByRole('menuitem', { name: /Second/ }).click()
    await expectCentered(page, 'Second')

    // Alt+arrows and Alt+brackets move between related nodes.
    await nodeHeader(page, 'First').click({ position: { x: 60, y: 10 } })
    await page.keyboard.press('Alt+ArrowUp')
    await expectCentered(page, 'Root')
    await page.keyboard.press('Alt+ArrowDown')
    await expectCentered(page, 'First')
    await page.keyboard.press('Alt+BracketRight')
    await expectCentered(page, 'Second')
    await page.keyboard.press('Alt+BracketLeft')
    await expectCentered(page, 'First')
    await page.keyboard.press('Alt+ArrowDown')
    await expectCentered(page, 'Grandchild')

    // A header is a keyboard stop: Enter hands the body the input, Escape gives it back.
    await nodeHeader(page, 'Grandchild').focus()
    await page.keyboard.press('Enter')
    await expect(nodeBody(page, 'Grandchild')).toHaveAttribute('data-active', 'true')
    await expect(nodeBody(page, 'Grandchild').getByRole('textbox', { name: 'Note text' })).toBeFocused()
    // Text editing keeps Alt+arrows to itself.
    await page.keyboard.press('Alt+ArrowUp')
    await expectCentered(page, 'Grandchild')
    await page.keyboard.press('Escape')
    await expect(nodeBody(page, 'Grandchild')).toHaveAttribute('data-active', 'false')
    await expect(nodeHeader(page, 'Grandchild')).toBeFocused()
    // Keyboard focus follows keyboard navigation.
    await page.keyboard.press('Alt+ArrowUp')
    await expect(nodeHeader(page, 'First')).toBeFocused()

    // Collapsing the node whose body has the input gives the input back to the canvas.
    await nodeBody(page, 'First').click()
    await expect(nodeBody(page, 'First')).toHaveAttribute('data-active', 'true')
    await canvasNode(page, 'First').getByRole('button', { name: 'Collapse node' }).click()
    await expect(nodeBody(page, 'First')).toHaveCount(0)
    await expect(currentFocus(page)).toHaveText(/First/)
    await page.keyboard.press('Alt+ArrowUp')
    await expect(currentFocus(page)).toHaveText(/Root/)
    await canvasNode(page, 'First').getByRole('button', { name: 'Expand node' }).click()
    await expect(nodeBody(page, 'First')).toHaveAttribute('data-active', 'false')

    await toolbar(page).getByRole('button', { name: 'Keyboard shortcuts' }).click()
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(help).toContainText('Go to the parent')
    await expect(help).toContainText('Next sibling')
    await page.keyboard.press('Escape')
    await expect(help).toBeHidden()
  } finally {
    await spade.app.close()
  }
})

test('connects an existing node by a labelled reference, counts it on both nodes, and removes it from the edge', async () => {
  test.setTimeout(90_000)
  const spade = await launchWithProject()
  const { page } = spade
  try {
    await seed(page, 'Spec', { seed: { position: { x: 0, y: 0 } } })
    await seed(page, 'Builder', { seed: { position: { x: 800, y: 0 } } })
    await fitAll(page)

    await nodeMenu(page, 'Builder', 'Connect existing…')
    await expect(page.getByTestId('picking-banner')).toContainText('Builder')
    await nodeHeader(page, 'Spec').click({ position: { x: 60, y: 10 } })
    const prompt = page.getByRole('dialog', { name: 'Reference Spec from Builder' })
    await prompt.getByLabel('Label').fill('follows')
    await prompt.getByRole('button', { name: 'Connect' }).click()

    await expect
      .poll(async () => (await readCanvas(page)).edges.filter((edge) => edge.relation === 'references').map((edge) => edge.label))
      .toEqual(['follows'])
    for (const title of ['Spec', 'Builder']) {
      await expect(canvasNode(page, title).getByTestId('reference-count')).toHaveText('1')
    }
    await canvasNode(page, 'Spec').getByTestId('related-nodes').click()
    await expect(page.getByRole('menu', { name: 'Related to Spec' }).getByRole('menuitem', { name: /Builder/ })).toContainText('follows')
    await page.keyboard.press('Escape')

    const edge = page.locator('.react-flow__edge.spade-edge--references')
    await expect(edge).toHaveCount(1)
    await expect(page.getByTestId('reference-edge-tag')).toHaveText('follows')
    await page.getByTestId('reference-edge-tag').click()
    await expect(edge).toHaveClass(/selected/)
    await page.getByRole('toolbar', { name: 'Reference' }).getByRole('button', { name: 'Remove reference' }).click()
    await expect(edge).toHaveCount(0)
    await expect(canvasNode(page, 'Spec').getByTestId('reference-count')).toHaveCount(0)
    expect((await readCanvas(page)).edges).toEqual([])
    await expectNoNotice(page)
  } finally {
    await spade.app.close()
  }
})

test('shows a minimap colored by type that moves the viewport and stays toggled for the session', async () => {
  test.setTimeout(90_000)
  const spade = await launchWithProject()
  const { page } = spade
  try {
    await seed(page, 'Note one', { seed: { position: { x: 0, y: 0 } } })
    await seed(page, 'Agent one', { seed: { ...agentSeed('agent-one'), position: { x: 1600, y: 1200 } } })
    await fitAll(page)

    const minimap = page.getByRole('img', { name: 'Minimap' })
    await expect(minimap).toBeVisible()
    await expect(minimap.locator('.react-flow__minimap-node')).toHaveCount(2)
    await expect(minimap.locator('.minimap-node--agent')).toHaveCount(1)
    await expect(minimap.locator('.minimap-node--note')).toHaveCount(1)

    await page.getByRole('button', { name: 'Zoom to 100%' }).click()
    const before = await renderedViewport(page)
    const box = (await minimap.boundingBox())!
    await page.mouse.click(box.x + box.width - 12, box.y + box.height - 12)
    await expect.poll(async () => (await renderedViewport(page)).x).not.toBe(before.x)

    const toggle = toolbar(page).getByRole('button', { name: 'Minimap' })
    await toggle.click()
    await expect(minimap).toHaveCount(0)
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')

    // Another project's canvas keeps the choice.
    const first = (await appState(page)).projects[0]
    await openProjectFromSidebar(spade, await scratchDirectory(scratch, 'second'))
    await expect(page.getByRole('img', { name: 'Minimap' })).toHaveCount(0)
    await projectButton(page, first.name).click()
    await expect(canvasNode(page, 'Note one')).toBeVisible()
    await expect(page.getByRole('img', { name: 'Minimap' })).toHaveCount(0)
    await toolbar(page).getByRole('button', { name: 'Minimap' }).click()
    await expect(page.getByRole('img', { name: 'Minimap' })).toBeVisible()
  } finally {
    await spade.app.close()
  }
})

test('switches node bodies to previews and the chrome to its overview below the readable zoom', async () => {
  const spade = await launchWithProject()
  const { page } = spade
  try {
    await seed(page, 'Overview')
    await page.getByRole('button', { name: 'Zoom to 100%' }).click()
    const node = canvasNode(page, 'Overview')
    await expect(node).toHaveAttribute('data-detail', 'full')
    await expect(nodeBody(page, 'Overview')).toHaveAttribute('data-detail', 'full')
    const title = node.getByRole('heading', { name: 'Overview' })
    const fullTitleHeight = (await title.boundingBox())!.height

    const zoomOut = toolbar(page).getByRole('button', { name: 'Zoom out' })
    while ((await renderedViewport(page)).zoom >= 0.5) {
      await zoomOut.click()
      await page.waitForTimeout(250)
    }
    await expect(node).toHaveAttribute('data-detail', 'preview')
    await expect(nodeBody(page, 'Overview')).toHaveAttribute('data-detail', 'preview')
    // The overview title grows in canvas units, so it stays legible on screen.
    const zoom = (await renderedViewport(page)).zoom
    expect((await title.boundingBox())!.height / zoom).toBeGreaterThan(fullTitleHeight * 1.3)

    await page.getByRole('button', { name: 'Zoom to 100%' }).click()
    await expect(node).toHaveAttribute('data-detail', 'full')
  } finally {
    await spade.app.close()
  }
})

test('edits the conversation expansion defaults and the Paseo daemon URL in the settings', async () => {
  const spade = await launchWithProject()
  const { page } = spade
  try {
    await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Settings' }).click()
    let dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog.getByRole('checkbox', { name: 'Tool calls' })).toBeChecked()
    await expect(dialog.getByRole('checkbox', { name: 'File reads' })).not.toBeChecked()
    await expect(dialog).toContainText('applies the next time SPADE starts')
    await dialog.getByRole('checkbox', { name: 'File reads' }).check()
    await dialog.getByRole('checkbox', { name: 'Thinking' }).uncheck()
    await dialog.getByLabel('Paseo daemon URL').fill('ws://127.0.0.1:7777/ws')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    await expect
      .poll(async () => (await appState(page)).settings)
      .toMatchObject({
        conversationExpansion: { toolCall: true, diff: true, html: true, thinking: false, read: true },
        paseoUrl: 'ws://127.0.0.1:7777/ws'
      })

    await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Settings' }).click()
    dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog.getByRole('checkbox', { name: 'File reads' })).toBeChecked()
    await dialog.getByLabel('Paseo daemon URL').fill('')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect.poll(async () => (await appState(page)).settings.paseoUrl).toBeNull()
  } finally {
    await spade.app.close()
  }
})

test('stays responsive with 100 mixed nodes: search, activity, minimap, level of detail, pan and zoom', async () => {
  test.setTimeout(180_000)
  const spade = await launchWithProject()
  const { page } = spade
  try {
    const types = (index: number): Partial<NodeSeed> =>
      index % 10 === 3
        ? agentSeed(`agent-${index}`)
        : index % 10 === 7
          ? { entityType: 'image', config: { source: { kind: 'path', path: `missing-${index}.png` }, caption: null } }
          : {}
    for (let tree = 0; tree < 10; tree += 1) {
      const root = `Node ${tree * 10}`
      await seed(page, root, { seed: { ...types(tree * 10), position: { x: tree * 900, y: 0 } } })
      for (let child = 1; child < 10; child += 1) {
        const index = tree * 10 + child
        await seed(page, `Node ${index}`, {
          parent: root,
          seed: { ...types(index), position: { x: tree * 900 + (child % 2) * 420, y: 300 + Math.floor(child / 2) * 760 } }
        })
      }
    }
    await expect(page.getByTestId('canvas-node')).toHaveCount(100)
    await fitAll(page)

    await expect(page.getByTestId('canvas-node').filter({ has: page.locator('[data-detail="preview"]') })).toHaveCount(100)
    await expect(page.getByRole('img', { name: 'Minimap' }).locator('.react-flow__minimap-node')).toHaveCount(100)
    await expect(page.getByRole('img', { name: 'Minimap' }).locator('.minimap-node--agent')).toHaveCount(10)

    await toolbar(page).getByRole('button', { name: 'Activity' }).click()
    await expect(sidePanel(page, 'Activity').getByTestId('activity-entry')).toHaveCount(100)

    await searchInput(page).fill('Node 73')
    await expect(page.getByRole('listbox', { name: 'Search results' }).getByRole('option').first()).toContainText('Node 73')
    await page.keyboard.press('Enter')
    await expectCentered(page, 'Node 73')
    await expect(canvasNode(page, 'Node 73')).toHaveAttribute('data-detail', 'full')

    // A burst of zoom and pan input settles well within a second or two on a loaded canvas.
    const pane = (await page.getByTestId('canvas').boundingBox())!
    const started = Date.now()
    await page.mouse.move(pane.x + 40, pane.y + pane.height - 40)
    for (let step = 0; step < 12; step += 1) await page.mouse.wheel(0, 120)
    await page.mouse.down()
    await page.mouse.move(pane.x + 300, pane.y + pane.height - 200, { steps: 12 })
    await page.mouse.up()
    for (let step = 0; step < 12; step += 1) await page.mouse.wheel(0, -120)
    let previous = JSON.stringify(await renderedViewport(page))
    await expect
      .poll(async () => {
        const current = JSON.stringify(await renderedViewport(page))
        const stable = current === previous
        previous = current
        return stable
      }, { intervals: [50, 50, 100] })
      .toBe(true)
    expect(Date.now() - started).toBeLessThan(8_000)
    await expectNoNotice(page)
  } finally {
    await spade.app.close()
  }
})
