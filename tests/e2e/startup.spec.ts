import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('starts the desktop shell with a canvas', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'spade-startup-'))
  const application = await electron.launch({ args: [resolve('.'), `--user-data-dir=${userData}`] })

  try {
    const window = await application.firstWindow()

    await expect(window).toHaveTitle('SPADE')
    await expect(window.getByRole('heading', { name: 'SPADE' })).toBeVisible()

    const canvas = window.getByRole('region', { name: 'SPADE canvas' })
    await expect(canvas).toBeVisible()
    await expect(canvas.locator('.react-flow__renderer')).toBeVisible()
  } finally {
    await application.close()
    await rm(userData, { recursive: true, force: true })
  }
})
