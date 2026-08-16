import { resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('renders generic nodes and drags them only from the full header', async () => {
  const application = await electron.launch({ args: [resolve('.')] })

  try {
    const window = await application.firstWindow()

    await expect(window).toHaveTitle('GADE')
    await expect(window.getByRole('heading', { name: 'GADE' })).toBeVisible()

    const canvas = window.getByRole('region', { name: 'GADE canvas' })
    await expect(canvas).toBeVisible()
    await expect(canvas.locator('.react-flow__renderer')).toBeVisible()

    const nodes = canvas.locator('.react-flow__node')
    await expect(nodes).toHaveCount(2)
    await expect(nodes.locator('.entity-node')).toHaveCount(2)

    const firstNode = nodes.filter({ hasText: 'Issue #4' })
    const bodyTarget = firstNode.getByText('Canvas-node foundation', { exact: true })
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

    await window.screenshot({ path: test.info().outputPath('gade-canvas.png') })
  } finally {
    await application.close()
  }
})
