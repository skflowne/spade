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
    const nonHandleTarget = firstNode.getByText('Issue #4', { exact: true })
    const dragHandle = firstNode.getByRole('button', { name: 'Drag Issue #4' })
    const initialPosition = await firstNode.boundingBox()
    expect(initialPosition).not.toBeNull()

    await expect(nonHandleTarget).not.toHaveClass(/\bnodrag\b/)
    const nonHandlePosition = await nonHandleTarget.boundingBox()
    expect(nonHandlePosition).not.toBeNull()
    await nonHandleTarget.hover()
    await window.mouse.down()
    await window.mouse.move(nonHandlePosition!.x + 100, nonHandlePosition!.y + 60, { steps: 5 })
    await window.mouse.up()

    const positionAfterNonHandleDrag = await firstNode.boundingBox()
    expect(positionAfterNonHandleDrag).not.toBeNull()
    expect(positionAfterNonHandleDrag!.x).toBeCloseTo(initialPosition!.x, 0)
    expect(positionAfterNonHandleDrag!.y).toBeCloseTo(initialPosition!.y, 0)

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
