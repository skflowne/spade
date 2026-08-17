import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

const docsRoot = resolve('docs')

test('compare button navigates directly to the comparison URL', async () => {
  const requests: Array<{ method: string; url: string }> = []
  const server = createServer(async (request, response) => {
    const url = request.url ?? '/'
    const pathname = new URL(url, 'http://127.0.0.1').pathname
    requests.push({ method: request.method ?? 'GET', url })

    if (pathname === '/docs/index.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(await readFile(resolve(docsRoot, 'index.html')))
      return
    }

    if (pathname === '/docs/style/docs-tools.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
      response.end(await readFile(resolve(docsRoot, 'style/docs-tools.js')))
      return
    }

    if (pathname.endsWith('.css')) {
      response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' })
      response.end('')
      return
    }

    if (pathname === '/__compare') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><title>Comparison reached</title>')
      return
    }

    response.writeHead(404)
    response.end()
  })

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const port = (server.address() as AddressInfo).port
  const application = await electron.launch({ args: [resolve('.')] })

  try {
    const window = await application.firstWindow()
    await window.goto(`http://127.0.0.1:${port}/docs/index.html`)
    await window.getByRole('link', { name: 'Compare with base' }).click()

    await expect(window).toHaveURL(`http://127.0.0.1:${port}/__compare?page=docs%2Findex.html`)
    expect(
      requests.filter(({ url }) => url.startsWith('/__compare')).map(({ method }) => method)
    ).toEqual(['GET'])
  } finally {
    await application.close()
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  }
})
