import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('starts the desktop shell with the project switcher and, without projects, the open-project overlay', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'spade-startup-'))
  const application = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${userData}`],
    env: { ...process.env, SPADE_DISABLE_PASEO: '1' }
  })

  try {
    const window = await application.firstWindow()

    await expect(window).toHaveTitle('SPADE')
    await expect(window.getByRole('navigation', { name: 'Projects' })).toBeVisible()

    const overlay = window.getByTestId('empty-state')
    await expect(overlay.getByRole('heading', { name: 'Open a project' })).toBeVisible()
    await expect(overlay.getByRole('button', { name: 'Open project…' })).toBeVisible()
  } finally {
    await application.close()
    await rm(userData, { recursive: true, force: true })
  }
})
