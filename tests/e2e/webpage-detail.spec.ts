import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PREVIEW_ZOOM_THRESHOLD } from '../../src/renderer/src/canvas/model/levelOfDetail'
import { canvasNode, execute, fitAll, launch, nodeMenu, openProjectFromSidebar, renderedViewport, scratchDirectory } from './ui-harness'

let scratch: string
let server: Server
let origin: string

test.beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'spade-webpage-detail-'))
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Detail page</title><h1>Detail</h1>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(scratch, { recursive: true, force: true })
})

test('a loaded page survives zooming out to the preview level and back', async () => {
  const spade = await launch(await scratchDirectory(scratch, 'user-data'))
  const { app, page } = spade
  const failures: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text())
  })
  try {
    await openProjectFromSidebar(spade, await scratchDirectory(scratch, 'project'))
    const created = await execute(page, { type: 'startTree', node: { entityType: 'webpage', config: { url: `${origin}/` } } })
    const far = await execute(page, { type: 'startTree', node: { entityType: 'note', config: { body: '' }, title: 'Far away' } })
    if (!created.ok || !far.ok) throw new Error('seeding failed')
    await execute(page, { type: 'moveNodes', moves: [{ nodeId: far.nodeId!, position: { x: 8_000, y: 6_000 } }] })
    const title = new URL(origin).host
    const guestTitles = (): Promise<string[]> =>
      app.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .filter((contents) => contents.getType() === 'webview' && !contents.isDestroyed())
          .map((contents) => contents.getTitle())
      )

    await nodeMenu(page, title, 'Fit')
    await expect.poll(guestTitles).toEqual(['Detail page'])

    // The zoom change and the guest's unmount land in the same commit.
    await fitAll(page)
    expect((await renderedViewport(page)).zoom).toBeLessThan(PREVIEW_ZOOM_THRESHOLD)
    await expect(canvasNode(page, title).getByTestId('webpage-guest')).toHaveCount(0)

    await nodeMenu(page, title, 'Fit')
    await expect(canvasNode(page, title).getByTestId('webpage-guest')).toBeVisible()
    await expect.poll(guestTitles).toEqual(['Detail page'])
    await expect(canvasNode(page, title).getByText(/could not be shown/)).toHaveCount(0)
    expect(failures).toEqual([])
  } finally {
    await app.close()
  }
})
