import { resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('starts Electron and renders the React Flow canvas', async () => {
  const application = await electron.launch({ args: [resolve('.')] })

  try {
    const window = await application.firstWindow()

    await expect(window).toHaveTitle('GADE')
    await expect(window.getByRole('heading', { name: 'GADE' })).toBeVisible()

    const canvas = window.getByRole('region', { name: 'GADE canvas' })
    await expect(canvas).toBeVisible()
    await expect(canvas.locator('.react-flow__renderer')).toBeVisible()

    await window.screenshot({ path: test.info().outputPath('gade-canvas.png') })
  } finally {
    await application.close()
  }
})
