import { resolve } from 'node:path'
import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test'

async function expectContainedBy(node: Locator, group: Locator): Promise<void> {
  const nodeBox = await node.boundingBox()
  const groupBox = await group.boundingBox()

  expect(nodeBox).not.toBeNull()
  expect(groupBox).not.toBeNull()
  expect(nodeBox!.x).toBeGreaterThanOrEqual(groupBox!.x)
  expect(nodeBox!.y).toBeGreaterThanOrEqual(groupBox!.y)
  expect(nodeBox!.x + nodeBox!.width).toBeLessThanOrEqual(groupBox!.x + groupBox!.width)
  expect(nodeBox!.y + nodeBox!.height).toBeLessThanOrEqual(groupBox!.y + groupBox!.height)
}

async function dragBy(window: Page, target: Locator, x: number, y: number): Promise<void> {
  const box = await target.boundingBox()
  expect(box).not.toBeNull()

  const startX = box!.x + box!.width / 2
  const startY = box!.y + box!.height / 2
  await window.mouse.move(startX, startY)
  await window.mouse.down()
  await window.mouse.move(startX + x, startY + y, { steps: 5 })
  await window.mouse.up()
}

interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

async function readCanvasViewport(canvas: Locator): Promise<CanvasViewport> {
  return canvas.locator('.react-flow__viewport').evaluate((viewport) => {
    const transform = new DOMMatrixReadOnly(getComputedStyle(viewport).transform)
    return { x: transform.m41, y: transform.m42, zoom: transform.a }
  })
}

async function panAndZoom(window: Page, canvas: Locator, panX: number, panY: number, wheelY: number): Promise<void> {
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()

  const startX = box!.x + box!.width / 2
  const startY = box!.y + box!.height * 0.9
  await window.mouse.move(startX, startY)
  await window.mouse.wheel(0, wheelY)
  await window.mouse.down()
  await window.mouse.move(startX + panX, startY + panY, { steps: 5 })
  await window.mouse.up()
}

async function expectCanvasViewport(canvas: Locator, expected: CanvasViewport): Promise<void> {
  await expect.poll(async () => (await readCanvasViewport(canvas)).x).toBeCloseTo(expected.x, 1)
  await expect.poll(async () => (await readCanvasViewport(canvas)).y).toBeCloseTo(expected.y, 1)
  await expect.poll(async () => (await readCanvasViewport(canvas)).zoom).toBeCloseTo(expected.zoom, 2)
}

async function openPrototypeControls(window: Page): Promise<void> {
  const trigger = window.getByRole('button', { name: 'Prototype controls' })
  if (await trigger.getAttribute('aria-expanded') === 'false') await trigger.click()
}

test('restores each dedicated project viewport after switching projects', async () => {
  const application = await electron.launch({ args: [resolve('.')] })

  try {
    const window = await application.firstWindow()
    const canvas = window.getByRole('region', { name: 'SPADE canvas' })
    const projectLinks = window.getByRole('navigation', { name: 'Project canvases' })
    const spade = projectLinks.getByRole('button', { name: /^SPADE/ })
    const paseo = projectLinks.getByRole('button', { name: /^Paseo/ })

    await panAndZoom(window, canvas, 90, -45, -240)
    await expect.poll(async () => (await readCanvasViewport(canvas)).zoom).toBeGreaterThan(0.7)
    const spadeViewport = await readCanvasViewport(canvas)

    await paseo.click()
    await expect(paseo).toHaveAttribute('aria-current', 'page')
    await expectCanvasViewport(canvas, { x: 24, y: 30, zoom: 0.55 })
    await panAndZoom(window, canvas, -70, 55, 180)
    await expect.poll(async () => (await readCanvasViewport(canvas)).zoom).toBeLessThan(0.75)
    const paseoViewport = await readCanvasViewport(canvas)
    expect(Math.abs(paseoViewport.x - spadeViewport.x)).toBeGreaterThan(20)
    expect(Math.abs(paseoViewport.y - spadeViewport.y)).toBeGreaterThan(20)
    expect(Math.abs(paseoViewport.zoom - spadeViewport.zoom)).toBeGreaterThan(0.1)

    await spade.click()
    await expect(spade).toHaveAttribute('aria-current', 'page')
    await expectCanvasViewport(canvas, spadeViewport)

    await paseo.click()
    await expect(paseo).toHaveAttribute('aria-current', 'page')
    await expectCanvasViewport(canvas, paseoViewport)
  } finally {
    await application.close()
  }
})

test('keeps long entity nodes inside both work-item grouping treatments while dragging', async () => {
  const application = await electron.launch({ args: [resolve('.')] })

  try {
    const window = await application.firstWindow()
    const canvas = window.getByRole('region', { name: 'SPADE canvas' })
    await openPrototypeControls(window)
    const entity = canvas.locator('.react-flow__node:has(.entity-node)').filter({ hasText: 'GitHub issue #10' })
    const longDetail = 'A representative long detail with wrapping words and an-uninterrupted-identifier-that-must-not-expand-the-authoritative-node-geometry'

    for (const grouping of ['Visual hull', 'Parent groups']) {
      await window.getByRole('button', { name: grouping }).click()
      const group = canvas.locator(`.react-flow__node:has(.canvas-group--${grouping === 'Visual hull' ? 'hull' : 'work-item'})`).filter({ hasText: '[SPADE-10]' })
      const detail = entity.locator('.entity-node__body p')

      await detail.evaluate((element, content) => { element.textContent = content }, longDetail)
      await expect(entity.locator('.entity-node')).toHaveCSS('width', '460px')
      await expect(entity.locator('.entity-node')).toHaveCSS('height', '320px')
      await expect(detail).toHaveCSS('overflow-wrap', 'anywhere')
      await expect(detail).toHaveCSS('overflow', 'hidden')
      await expectContainedBy(entity, group)

      const initialBox = await entity.boundingBox()
      expect(initialBox).not.toBeNull()
      await dragBy(window, entity.locator('.entity-node__chrome'), 36, 20)
      await expect.poll(async () => (await entity.boundingBox())?.x).toBeGreaterThan(initialBox!.x + 10)
      await expectContainedBy(entity, group)
    }

    const parentPosition = await entity.boundingBox()
    expect(parentPosition).not.toBeNull()
    await window.getByRole('button', { name: 'Visual hull' }).click()
    await expect(canvas.locator('.canvas-group--hull').filter({ hasText: '[SPADE-10]' })).toBeVisible()
    await expect.poll(async () => (await entity.boundingBox())?.x).toBeCloseTo(parentPosition!.x, 0)
    await expect.poll(async () => (await entity.boundingBox())?.y).toBeCloseTo(parentPosition!.y, 0)
  } finally {
    await application.close()
  }
})

test('automatically refits project groups when a child moves', async () => {
  const application = await electron.launch({ args: [resolve('.')] })

  try {
    const window = await application.firstWindow()
    await openPrototypeControls(window)
    await window.getByRole('button', { name: 'Global canvas' }).click()

    const project = window.locator('.react-flow__node:has(.canvas-group--project)').filter({ hasText: 'SPADE' })
    const browser = window.locator('.react-flow__node:has(.entity-node)').filter({ hasText: 'GitHub · Browser composition #12' })
    const initialProjectBox = await project.boundingBox()
    expect(initialProjectBox).not.toBeNull()

    await dragBy(window, browser.locator('.entity-node__chrome'), 0, 80)
    await expect.poll(async () => (await project.boundingBox())?.height).toBeGreaterThan(initialProjectBox!.height + 40)

    await dragBy(window, browser.locator('.entity-node__chrome'), 0, -80)
    await expect.poll(async () => (await project.boundingBox())?.height).toBeCloseTo(initialProjectBox!.height, 0)
  } finally {
    await application.close()
  }
})

test('keeps categorical project colors distinct from semantic states in every projection', async () => {
  const application = await electron.launch({ args: [resolve('.')] })

  try {
    const window = await application.firstWindow()
    const projectLinks = window.getByRole('navigation', { name: 'Project canvases' }).getByRole('button')
    const projectColors = await projectLinks.locator('i').evaluateAll((indicators) =>
      indicators.map((indicator) => getComputedStyle(indicator).backgroundColor)
    )
    const semanticAliases = ['--accent', '--success', '--warning', '--danger']
    const semanticColors = await window.locator(':root').evaluate((root, aliases) => {
      const styles = getComputedStyle(root)
      return aliases.map((alias) => {
        const probe = document.createElement('span')
        probe.style.color = styles.getPropertyValue(alias).trim()
        root.appendChild(probe)
        const color = getComputedStyle(probe).color
        probe.remove()
        return { alias, color }
      })
    }, semanticAliases)

    expect(new Set(projectColors).size).toBe(4)
    expect(
      semanticColors.filter(({ color }) => projectColors.includes(color)),
      'categorical project colors must not collide with interaction or semantic colors'
    ).toEqual([])

    await openPrototypeControls(window)
    await window.getByRole('button', { name: 'Global canvas' }).click()
    const projectGroups = window.locator('.canvas-group--project')
    await expect(projectGroups).toHaveCount(4)
    expect(new Set(await projectGroups.evaluateAll((groups) =>
      groups.map((group) => getComputedStyle(group).borderTopColor)
    )).size).toBe(4)

    await window.getByRole('button', { name: 'Parent groups' }).click()
    await expect(window.locator('.canvas-group--work-item')).toHaveCount(10)
    expect(new Set(await window.locator('.canvas-group--work-item').evaluateAll((groups) =>
      groups.map((group) => getComputedStyle(group).borderTopColor)
    )).size).toBe(4)

    await window.getByRole('button', { name: 'Project canvases' }).click()
    await window.getByRole('button', { name: 'Visual hull' }).click()
    const hullColors: string[] = []
    for (let index = 0; index < await projectLinks.count(); index += 1) {
      await projectLinks.nth(index).click()
      const hulls = window.locator('.canvas-group--hull')
      await expect(hulls.first()).toBeVisible()
      hullColors.push(await hulls.first().evaluate((hull) => getComputedStyle(hull).borderTopColor))
    }
    expect(new Set(hullColors).size).toBe(4)
  } finally {
    await application.close()
  }
})

test('fits an individual node to the canvas viewport', async () => {
  const application = await electron.launch({ args: [resolve('.')] })

  try {
    const window = await application.firstWindow()
    const canvas = window.getByRole('region', { name: 'SPADE canvas' })
    const nodes = canvas.locator('.react-flow__node:has(.entity-node)')
    const issue = nodes.filter({ hasText: 'GitHub issue #10' })
    const fitButton = issue.getByRole('button', { name: 'Fit GitHub issue #10 to screen' })

    await expect(nodes.getByRole('button', { name: /^Fit .+ to screen$/ })).toHaveCount(13)
    await expect(fitButton).toHaveCSS('cursor', 'pointer')
    await fitButton.click()

    await expect.poll(async () => (await readCanvasViewport(canvas)).zoom).toBeCloseTo(1.1, 1)
    await expectContainedBy(issue, canvas)
  } finally {
    await application.close()
  }
})

test('renders generic nodes and drags them only from the full header', async () => {
  const application = await electron.launch({ args: [resolve('.')] })

  try {
    const window = await application.firstWindow()

    await expect(window).toHaveTitle('SPADE')

    const canvas = window.getByRole('region', { name: 'SPADE canvas' })
    await expect(canvas).toBeVisible()
    await expect(canvas.locator('.react-flow__renderer')).toBeVisible()

    const nodes = canvas.locator('.react-flow__node:has(.entity-node)')
    await expect(nodes).toHaveCount(13)
    await expect(nodes.locator('.entity-node')).toHaveCount(13)
    await expect(nodes.locator('.entity-node[data-kind="browser"]')).toHaveCount(1)
    await expect(nodes.locator('.browser-page')).toContainText('github.com/skflowne/spade/issues/12')
    await expect(nodes.filter({ hasText: 'Integrator agent' }).locator('.entity-node')).toHaveCSS('height', '860px')
    await expect(nodes.filter({ hasText: 'GitHub · Browser composition #12' }).locator('.entity-node')).toHaveCSS('height', '940px')

    const firstNode = nodes.filter({ hasText: 'GitHub issue #10' })
    const bodyTarget = firstNode.getByRole('paragraph')
    const header = firstNode.locator('.entity-node__chrome')
    const initialPosition = await firstNode.boundingBox()
    expect(initialPosition).not.toBeNull()

    await expect(canvas.locator('.react-flow__pane')).toHaveCSS('cursor', 'default')
    await expect(bodyTarget).toHaveCSS('cursor', 'default')
    await expect(header).toHaveCSS('cursor', 'grab')
    await expect(firstNode.locator('.entity-node__drag-handle')).toHaveCount(0)
    const bodyPosition = await bodyTarget.boundingBox()
    expect(bodyPosition).not.toBeNull()
    await bodyTarget.hover()
    await window.mouse.down()
    await window.mouse.move(bodyPosition!.x + 100, bodyPosition!.y + 60, { steps: 5 })
    await window.mouse.up()

    const positionAfterBodyDrag = await firstNode.boundingBox()
    expect(positionAfterBodyDrag).not.toBeNull()
    expect(positionAfterBodyDrag!.x).toBeCloseTo(initialPosition!.x, 0)
    expect(positionAfterBodyDrag!.y).toBeCloseTo(initialPosition!.y, 0)

    const headerPosition = await header.boundingBox()
    expect(headerPosition).not.toBeNull()
    const headerDragX = headerPosition!.x + headerPosition!.width / 2
    const headerDragY = headerPosition!.y + headerPosition!.height / 2
    await window.mouse.move(headerDragX, headerDragY)
    await window.mouse.down()
    await window.mouse.move(headerDragX + 100, headerDragY + 60, { steps: 5 })
    await window.mouse.up()

    await expect
      .poll(async () => (await firstNode.boundingBox())?.x)
      .toBeGreaterThan(initialPosition!.x + 40)

    await window.screenshot({ path: test.info().outputPath('spade-canvas.png') })
  } finally {
    await application.close()
  }
})
