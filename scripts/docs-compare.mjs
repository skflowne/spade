import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = parseArguments(process.argv.slice(2))
const baseRef = options.base ?? defaultBaseRef()
const initialPage = normalizeRepoPath(options.page ?? 'docs/index.html')
const port = options.port ?? 4173

const server = createServer((request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `127.0.0.1:${port}`}`)

    if (url.pathname === '/') {
      redirect(response, `/${initialPage}`)
      return
    }

    if (url.pathname === '/__compare') {
      const page = normalizeRepoPath(url.searchParams.get('page') ?? initialPage)
      const requestedBase = normalizeRef(url.searchParams.get('base') ?? baseRef)
      send(response, 200, 'text/html; charset=utf-8', comparisonPage(page, requestedBase))
      return
    }

    const baseRoute = url.pathname.match(/^\/__compare\/base\/([^/]+)\/(.+)$/)
    if (baseRoute) {
      const [, rawRef, rawPath] = baseRoute
      serveGitFile(response, normalizeRef(decodeURIComponent(rawRef)), normalizeRepoPath(rawPath))
      return
    }

    const currentRoute = url.pathname.match(/^\/__compare\/current\/(.+)$/)
    if (currentRoute) {
      serveWorkingFile(response, normalizeRepoPath(currentRoute[1]))
      return
    }

    serveWorkingFile(response, normalizeRepoPath(url.pathname))
  } catch (error) {
    send(response, 400, 'text/plain; charset=utf-8', error instanceof Error ? error.message : String(error))
  }
})

server.on('error', (error) => {
  process.stderr.write(`Unable to start docs comparison server: ${error.message}\n`)
  process.exitCode = 1
})

server.listen(port, '127.0.0.1', () => {
  const origin = `http://127.0.0.1:${port}`
  const pageUrl = `${origin}/${initialPage}`
  const comparisonUrl = `${origin}/__compare?base=${encodeURIComponent(baseRef)}&page=${encodeURIComponent(initialPage)}`

  process.stdout.write([
    `Docs:       ${pageUrl}`,
    `Comparison: ${comparisonUrl}`,
    `Base:       ${baseRef}`,
    '',
    'Open any documentation page and use “Compare with base”, or open the comparison URL directly.',
    'Press Ctrl+C to stop.',
    ''
  ].join('\n'))
})

function parseArguments(args) {
  const parsed = {}

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const next = args[index + 1]

    if (argument === '--base' && next) {
      parsed.base = normalizeRef(next)
      index += 1
    } else if (argument === '--page' && next) {
      parsed.page = next
      index += 1
    } else if (argument === '--port' && next) {
      const value = Number(next)
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`Invalid port: ${next}`)
      }
      parsed.port = value
      index += 1
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`)
    }
  }

  return parsed
}

function defaultBaseRef() {
  try {
    return normalizeRef(execFileSync(
      'git',
      ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      { cwd: root, encoding: 'utf8' }
    ).trim())
  } catch {
    return 'origin/main'
  }
}

function normalizeRef(ref) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/~^-]*$/.test(ref)) {
    throw new Error(`Invalid Git ref: ${ref}`)
  }
  return ref
}

function normalizeRepoPath(path) {
  const decoded = decodeURIComponent(path).replace(/^\/+/, '')
  const absolute = resolve(root, decoded)

  if (!/^[A-Za-z0-9._/-]+$/.test(decoded) || (absolute !== root && !absolute.startsWith(`${root}${sep}`))) {
    throw new Error(`Invalid repository path: ${path}`)
  }

  return decoded
}

function serveWorkingFile(response, path) {
  const absolute = resolve(root, path)

  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    sendMissing(response, path, 'working tree')
    return
  }

  response.writeHead(200, { 'Content-Type': contentType(path), 'Cache-Control': 'no-store' })
  createReadStream(absolute).pipe(response)
}

function serveGitFile(response, ref, path) {
  try {
    const content = execFileSync('git', ['show', `${ref}:${path}`], {
      cwd: root,
      encoding: null,
      maxBuffer: 20 * 1024 * 1024
    })
    send(response, 200, contentType(path), content)
  } catch {
    sendMissing(response, path, ref)
  }
}

function sendMissing(response, path, revision) {
  if (extname(path).toLowerCase() === '.html') {
    send(response, 404, 'text/html; charset=utf-8', missingPage(path, revision))
  } else {
    send(response, 404, 'text/plain; charset=utf-8', `${path} does not exist in ${revision}.`)
  }
}

function send(response, status, type, body) {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  response.end(body)
}

function redirect(response, location) {
  response.writeHead(302, { Location: location, 'Cache-Control': 'no-store' })
  response.end()
}

function contentType(path) {
  return {
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp'
  }[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function comparisonPage(page, base) {
  const baseSource = `/__compare/base/${encodeURIComponent(base)}/${encodeURI(page)}`
  const currentSource = `/__compare/current/${encodeURI(page)}`
  const backSource = `/${encodeURI(page)}`

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(page)} comparison</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #0c0f14; color: #e8edf5; }
    header { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; min-height: 48px; border-bottom: 1px solid #2b3442; background: #171c24; }
    header > * { min-width: 0; }
    .revision { padding: 8px 14px; font: 12px ui-monospace, monospace; }
    .revision:last-child { text-align: right; }
    .revision b { display: block; overflow: hidden; color: #e8edf5; text-overflow: ellipsis; white-space: nowrap; }
    .revision span { color: #8792a3; }
    nav { display: flex; align-items: center; gap: 12px; }
    nav a, nav label { color: #8792a3; font-size: 12px; }
    nav a:hover { color: #e8edf5; }
    .legend { display: flex; gap: 8px; }
    .legend span::before { display: inline-block; width: 8px; height: 8px; margin-right: 4px; border-radius: 2px; content: ''; }
    .legend__removed::before { background: #f85149; }
    .legend__added::before { background: #3fb950; }
    main { display: grid; grid-template-columns: 1fr 1fr; height: calc(100vh - 49px); }
    iframe { width: 100%; height: 100%; border: 0; background: #0f1319; }
    iframe + iframe { border-left: 1px solid #2b3442; }
    @media (max-width: 700px) {
      header { grid-template-columns: 1fr 1fr; }
      nav { grid-column: 1 / -1; grid-row: 2; justify-content: center; padding: 6px; border-top: 1px solid #2b3442; }
      main { height: calc(100vh - 82px); }
    }
  </style>
</head>
<body>
  <header>
    <div class="revision"><span>BASE</span><b>${escapeHtml(base)}</b></div>
    <nav aria-label="Comparison controls">
      <a href="${backSource}">Back to page</a>
      <div class="legend" aria-label="Diff colors"><span class="legend__removed">Removed</span><span class="legend__added">Added</span></div>
      <label><input id="highlight" type="checkbox" checked> Highlight changes</label>
      <label><input id="sync" type="checkbox" checked> Sync scroll</label>
    </nav>
    <div class="revision"><span>CURRENT</span><b>Working tree</b></div>
  </header>
  <main>
    <iframe id="base" title="${escapeHtml(base)} version" src="${baseSource}"></iframe>
    <iframe id="current" title="Working tree version" src="${currentSource}"></iframe>
  </main>
  <script>
    const baseFrame = document.querySelector('#base')
    const currentFrame = document.querySelector('#current')
    const highlightToggle = document.querySelector('#highlight')
    const syncToggle = document.querySelector('#sync')
    const blockSelector = 'h1, h2, h3, h4, h5, h6, p, li, th, td, pre, blockquote, figcaption, img'
    let syncing = false

    function diffBlocks(frame, kind, unchanged) {
      const document = frame.contentDocument
      const blocks = [...document.querySelectorAll(blockSelector)]
        .filter((element) => !element.querySelector(blockSelector))
      const style = document.createElement('style')
      style.textContent =
        'html.docs-diff-enabled [data-docs-diff="removed"] { background: rgb(248 81 73 / 20%) !important; box-shadow: inset 3px 0 #f85149; }' +
        'html.docs-diff-enabled [data-docs-diff="added"] { background: rgb(63 185 80 / 20%) !important; box-shadow: inset 3px 0 #3fb950; }'
      document.head.append(style)

      for (const block of blocks) {
        const signature = blockSignature(block)
        const remaining = unchanged.get(signature) ?? 0
        if (remaining > 0) {
          unchanged.set(signature, remaining - 1)
        } else {
          block.dataset.docsDiff = kind
        }
      }
    }

    function signatures(frame) {
      const counts = new Map()
      const blocks = [...frame.contentDocument.querySelectorAll(blockSelector)]
        .filter((element) => !element.querySelector(blockSelector))
      for (const block of blocks) {
        const signature = blockSignature(block)
        counts.set(signature, (counts.get(signature) ?? 0) + 1)
      }
      return counts
    }

    function blockSignature(block) {
      return block.tagName + ':' + (block.tagName === 'IMG'
        ? block.getAttribute('src') + ':' + block.getAttribute('alt')
        : block.textContent.replace(/\\s+/g, ' ').trim())
    }

    function setHighlighting(enabled) {
      for (const frame of [baseFrame, currentFrame]) {
        frame.contentDocument.documentElement.classList.toggle('docs-diff-enabled', enabled)
      }
    }

    function connect(source, target) {
      source.contentWindow.addEventListener('scroll', () => {
        if (!syncToggle.checked || syncing) return
        const sourceRoot = source.contentDocument.documentElement
        const targetRoot = target.contentDocument.documentElement
        const sourceRange = sourceRoot.scrollHeight - source.contentWindow.innerHeight
        const targetRange = targetRoot.scrollHeight - target.contentWindow.innerHeight
        if (sourceRange <= 0 || targetRange <= 0) return
        syncing = true
        target.contentWindow.scrollTo(0, source.contentWindow.scrollY / sourceRange * targetRange)
        requestAnimationFrame(() => { syncing = false })
      }, { passive: true })
    }

    Promise.all([
      new Promise((resolve) => baseFrame.addEventListener('load', resolve, { once: true })),
      new Promise((resolve) => currentFrame.addEventListener('load', resolve, { once: true }))
    ]).then(() => {
      diffBlocks(baseFrame, 'removed', signatures(currentFrame))
      diffBlocks(currentFrame, 'added', signatures(baseFrame))
      setHighlighting(highlightToggle.checked)
      highlightToggle.addEventListener('change', () => setHighlighting(highlightToggle.checked))
      connect(baseFrame, currentFrame)
      connect(currentFrame, baseFrame)
    })
  </script>
</body>
</html>`
}

function missingPage(path, revision) {
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page unavailable</title><style>:root{color-scheme:dark}body{display:grid;min-height:100vh;margin:0;place-items:center;background:#0f1319;color:#e8edf5;font:14px system-ui,sans-serif}main{max-width:560px;padding:28px;border:1px solid #2b3442;border-radius:9px;background:#171c24}code{color:#6ea8fe}</style></head><body><main><h1>Page unavailable</h1><p><code>${escapeHtml(path)}</code> does not exist in <code>${escapeHtml(revision)}</code>.</p></main></body></html>`
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
