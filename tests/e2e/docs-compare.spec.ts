import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('comparison highlights added and removed documentation blocks', async () => {
  const port = 4174
  const docsServer = spawn(process.execPath, [
    'scripts/docs-compare.mjs',
    '--port', String(port),
    '--page', 'docs/plan.html'
  ])
  await new Promise<void>((resolveReady, reject) => {
    docsServer.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Comparison:')) resolveReady()
    })
    docsServer.once('error', reject)
    docsServer.once('exit', (code) => reject(new Error(`Docs server exited with code ${code}`)))
  })
  const application = await electron.launch({ args: [resolve('.')] })

  try {
    const window = await application.firstWindow()
    await window.goto(`http://127.0.0.1:${port}/__compare?base=origin%2Fmain&page=docs%2Fplan.html`)
    const baseFrame = window.frameLocator('#base')
    const currentFrame = window.frameLocator('#current')

    await expect(baseFrame.locator('[data-docs-diff="removed"]').first()).toBeVisible()
    await expect(currentFrame.locator('[data-docs-diff="added"]').first()).toBeVisible()
    await expect(currentFrame.locator('html')).toHaveClass(/docs-diff-enabled/)

    await window.getByRole('checkbox', { name: 'Highlight changes' }).uncheck()
    await expect(currentFrame.locator('html')).not.toHaveClass(/docs-diff-enabled/)
  } finally {
    await application.close()
    docsServer.kill()
  }
})
