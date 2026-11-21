import { resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('starts the desktop shell with a canvas', async () => {
  const application = await electron.launch({ args: [resolve('.')] })

  try {
    const window = await application.firstWindow()

    await expect(window).toHaveTitle('SPADE')
    await expect(window.getByRole('heading', { name: 'SPADE' })).toBeVisible()

    const canvas = window.getByRole('region', { name: 'SPADE canvas' })
    await expect(canvas).toBeVisible()
    await expect(canvas.locator('.react-flow__renderer')).toBeVisible()
  } finally {
    await application.close()
  }
})
