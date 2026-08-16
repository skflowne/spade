import { resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('renders generic nodes and drags them only from the dedicated handle', async () => {
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
    const bodyControl = firstNode.getByRole('button', { name: 'Interactive node content' })
    const dragHandle = firstNode.getByRole('button', { name: 'Drag Issue #4' })
    const initialPosition = await firstNode.boundingBox()
    expect(initialPosition).not.toBeNull()

    const bodyPosition = await bodyControl.boundingBox()
    expect(bodyPosition).not.toBeNull()
    await bodyControl.hover()
    await window.mouse.down()
    await window.mouse.move(bodyPosition!.x + 100, bodyPosition!.y + 60, { steps: 5 })
    await window.mouse.up()

    const positionAfterBodyDrag = await firstNode.boundingBox()
    expect(positionAfterBodyDrag).not.toBeNull()
    expect(positionAfterBodyDrag!.x).toBeCloseTo(initialPosition!.x, 0)
    expect(positionAfterBodyDrag!.y).toBeCloseTo(initialPosition!.y, 0)

    const handlePosition = await dragHandle.boundingBox()
    expect(handlePosition).not.toBeNull()
    await dragHandle.hover()
    await window.mouse.down()
    await window.mouse.move(handlePosition!.x + 100, handlePosition!.y + 60, { steps: 5 })
    await window.mouse.up()

    await expect
      .poll(async () => (await firstNode.boundingBox())?.x)
      .toBeGreaterThan(initialPosition!.x + 40)

    await window.screenshot({ path: test.info().outputPath('gade-canvas.png') })
  } finally {
    await application.close()
  }
})
