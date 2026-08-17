import { resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('keeps categorical project colors distinct from semantic states in every projection', async () => {
  const application = await electron.launch({ args: [resolve('.')] })

  try {
    const window = await application.firstWindow()
    const projectLinks = window.getByRole('navigation', { name: 'Project canvases' }).getByRole('button')
    const projectColors = await projectLinks.locator('i').evaluateAll((indicators) =>
      indicators.map((indicator) => getComputedStyle(indicator).backgroundColor)
    )
    const semanticColors = await window.locator(':root').evaluate((root) => {
      const styles = getComputedStyle(root)
      return [styles.getPropertyValue('--success').trim(), styles.getPropertyValue('--warning').trim()]
        .map((color) => {
          const probe = document.createElement('span')
          probe.style.color = color
          root.appendChild(probe)
          const resolved = getComputedStyle(probe).color
          probe.remove()
          return resolved
        })
    })

    expect(new Set(projectColors).size).toBe(4)
    expect(projectColors).not.toEqual(expect.arrayContaining(semanticColors))

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

test('renders generic nodes and drags them only from the full header', async () => {
  const application = await electron.launch({ args: [resolve('.')] })

  try {
    const window = await application.firstWindow()

    await expect(window).toHaveTitle('SPADE')
    await expect(window.getByRole('heading', { name: 'SPADE' })).toBeVisible()

    const canvas = window.getByRole('region', { name: 'SPADE canvas' })
    await expect(canvas).toBeVisible()
    await expect(canvas.locator('.react-flow__renderer')).toBeVisible()

    const nodes = canvas.locator('.react-flow__node:has(.entity-node)')
    await expect(nodes).toHaveCount(12)
    await expect(nodes.locator('.entity-node')).toHaveCount(12)

    const firstNode = nodes.filter({ hasText: 'GitHub issue #10' })
    const bodyTarget = firstNode.getByText('Implement selected from a mocked issue browser', { exact: true })
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
    const headerDragX = headerPosition!.x + headerPosition!.width - 15
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
