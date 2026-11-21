import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { AgentRuntime, ConversationItem } from '../../src/shared/agents'
import type { Canvas, CanvasNode } from '../../src/shared/domain'
import type { SpadeHostBridge } from '../../src/shared/ipc'
import { indexTree } from '../../src/shared/tree'
import { png } from '../e2e/agent-harness'
import {
  canvasNode,
  createNoteFromToolbar,
  fitAll,
  nodeBody,
  nodeHeader,
  nodeMenu,
  pickNext,
  projectButton,
  readCanvas,
  type Spade
} from '../e2e/ui-harness'

// The first usable version (plan §20, B1 to B5) driven through the real UI against the real local Paseo
// daemon. Not part of `npm test`: it spawns one real, cheap agent per run and archives it afterwards.
//
//   xvfb-run -a npm run test:live
//
// Environment: SPADE_LIVE_MODEL (claude-haiku-4-5), SPADE_LIVE_MODE (default: "Always Ask", so the run
// answers real permission requests through the Allow button), SPADE_LIVE_KEEP=1 (keep the scratch data).

const execFileAsync = promisify(execFile)
type HostWindow = Window & { spadeHost: SpadeHostBridge }
type ShellCall = { method: string; target: string }

const MODEL = process.env.SPADE_LIVE_MODEL ?? 'claude-haiku-4-5'
const MODE = process.env.SPADE_LIVE_MODE ?? 'default'
const TURN_TIMEOUT_MS = 8 * 60_000
const AGENT_TITLE = 'Live agent'
const SHOTS = resolve('artifacts', 'live')

let scratch: string
let running: Spade | null = null
let server: Server
let pageUrl: string
const createdAgentIds = new Set<string>()
const mainLog: string[] = []

test.beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'spade-live-'))
  await mkdir(SHOTS, { recursive: true })
  server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>SPADE live page</title><h1>Served for ${request.url}</h1>`)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/live.html`
})

test.afterAll(async () => {
  await writeFile(join(SHOTS, 'main-process.log'), mainLog.join(''))
  // Only the agents this run created; anything else on the daemon is never touched.
  for (const agentId of createdAgentIds) {
    await execFileAsync('paseo', ['agent', 'archive', agentId]).catch((error: unknown) => {
      console.error(`Could not archive agent ${agentId}`, error)
    })
  }
  server?.closeAllConnections()
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()))
  if (scratch && !process.env.SPADE_LIVE_KEEP) await rm(scratch, { recursive: true, force: true })
})

// eslint-disable-next-line no-empty-pattern -- Playwright requires the fixtures pattern
test.afterEach(async ({}, testInfo) => {
  if (!running) return
  if (testInfo.status !== testInfo.expectedStatus) {
    await running.page.screenshot({ path: join(SHOTS, 'failure.png') }).catch(() => undefined)
  }
  await running.app.close().catch(() => undefined)
  running = null
})

async function launchLive(userData: string): Promise<Spade> {
  // This runner may itself be a Paseo agent; SPADE must not inherit that identity.
  const dropped = new Set(['SPADE_DISABLE_PASEO', 'PASEO_AGENT_ID', 'PASEO_WORKSPACE_ID', 'PASEO_AGENT_CWD'])
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !dropped.has(key)) env[key] = value
  const app = await electron.launch({ args: [resolve('.'), `--user-data-dir=${userData}`], env })
  app.process().stdout?.on('data', (chunk: Buffer) => mainLog.push(chunk.toString()))
  app.process().stderr?.on('data', (chunk: Buffer) => mainLog.push(chunk.toString()))
  const page = await app.firstWindow()
  running = { app, page }
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.waitForFunction(() => 'spadeHost' in window)
  await expect(page.getByTestId('app-shell')).toBeVisible()
  // Reveal and open-in-browser are recorded rather than launching a file manager or a browser.
  await app.evaluate(({ shell }) => {
    const calls: ShellCall[] = []
    ;(globalThis as unknown as { __shellCalls: ShellCall[] }).__shellCalls = calls
    shell.showItemInFolder = (path: string) => void calls.push({ method: 'showItemInFolder', target: path })
    shell.openPath = async (path: string) => {
      calls.push({ method: 'openPath', target: path })
      return ''
    }
    shell.openExternal = async (url: string) => void calls.push({ method: 'openExternal', target: url })
  })
  await expect.poll(async () => (await state(page)).paseo.state, { timeout: 30_000 }).toBe('connected')
  return { app, page }
}

async function shellCalls(app: ElectronApplication): Promise<ShellCall[]> {
  return app.evaluate(() => (globalThis as unknown as { __shellCalls: ShellCall[] }).__shellCalls)
}

async function state(page: Page): Promise<Awaited<ReturnType<SpadeHostBridge['app']['getState']>>> {
  return page.evaluate(() => (window as unknown as HostWindow).spadeHost.app.getState())
}

async function runtimeOf(page: Page, projectId: string, nodeId: string): Promise<AgentRuntime | undefined> {
  const runtimes = await page.evaluate((id) => (window as unknown as HostWindow).spadeHost.agents.getRuntimes(id), projectId)
  return runtimes.find((runtime) => runtime.nodeId === nodeId)
}

// The whole conversation, oldest first, read page by page.
async function conversationOf(page: Page, nodeId: string): Promise<ConversationItem[]> {
  const items: ConversationItem[] = []
  let before: string | undefined
  for (;;) {
    const result = await page.evaluate(
      ([id, cursor]) => (window as unknown as HostWindow).spadeHost.agents.getTimeline(id, cursor ? { before: cursor } : {}),
      [nodeId, before] as const
    )
    if (!result.ok) throw new Error(`Could not read the conversation: ${result.error.message}`)
    items.unshift(...result.page.items)
    if (result.page.olderCursor === null) return items
    before = result.page.olderCursor
  }
}

function assistantTexts(items: ConversationItem[]): string[] {
  return items.flatMap((item) => (item.kind === 'assistant-message' ? [item.text] : []))
}

function nodeTitled(canvas: Canvas, title: string): CanvasNode {
  const matches = canvas.nodes.filter((node) => node.title === title)
  expect(matches, `exactly one node titled ${title}`).toHaveLength(1)
  return matches[0]
}

// Brings a node to a readable zoom and gives its body the pointer.
async function showNode(page: Page, title: string): Promise<Locator> {
  await fitAll(page)
  await nodeMenu(page, title, 'Fit')
  return activate(page, title)
}

// Without moving the viewport, which would unmount the composer's unsent state under level of detail.
async function activate(page: Page, title: string): Promise<Locator> {
  const body = nodeBody(page, title)
  await nodeHeader(page, title).click({ position: { x: 60, y: 10 } })
  await body.click({ position: { x: 8, y: 8 } })
  await expect(body).toHaveAttribute('data-active', 'true')
  return body
}

// Answers every permission request through the Allow button until the agent is idle and `done` holds.
async function driveTurn(
  page: Page,
  projectId: string,
  nodeId: string,
  done: (items: ConversationItem[]) => boolean
): Promise<number> {
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let allowed = 0
  while (Date.now() < deadline) {
    const runtime = await runtimeOf(page, projectId, nodeId)
    const request = runtime?.pendingPermissions[0]
    if (request) {
      const body = await showNode(page, AGENT_TITLE)
      const card = body.getByRole('article', { name: `Permission request: ${request.title ?? request.name}` }).first()
      await expect(card).toBeVisible()
      if (allowed === 0) await page.screenshot({ path: join(SHOTS, '03-permission-request.png') })
      await card.getByRole('button', { name: 'Allow' }).click()
      await expect
        .poll(async () => (await runtimeOf(page, projectId, nodeId))?.pendingPermissions.some((pending) => pending.id === request.id))
        .toBe(false)
      allowed += 1
      continue
    }
    if (runtime?.activity === 'error') throw new Error(`The agent failed: ${runtime.lastError ?? runtime.status}`)
    if (runtime?.activity === 'idle' && done(await conversationOf(page, nodeId))) return allowed
    await page.waitForTimeout(1_000)
  }
  throw new Error(`The agent did not finish its turn within ${TURN_TIMEOUT_MS} ms`)
}

async function listFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name)
    const key = relative(root, path)
    files.set(key, entry.isFile() ? createHash('sha256').update(await readFile(path)).digest('hex') : entry.isDirectory() ? 'dir' : 'other')
  }
  return files
}

function snapshotOf(canvas: Canvas): { nodes: string[]; edges: string[] } {
  return {
    nodes: canvas.nodes.map((node) => `${node.id} ${node.entityType} ${node.title} ${node.resourceRef?.id ?? '-'}`).sort(),
    edges: canvas.edges.map((edge) => `${edge.fromNodeId} -${edge.relation}/${edge.origin ?? '-'}-> ${edge.toNodeId}`).sort()
  }
}

test('the first usable version works end to end against the live Paseo daemon', async () => {
  const userData = join(scratch, 'user-data')
  const quietRoot = join(scratch, 'quiet-project')
  const agentRoot = join(scratch, 'agent-project')
  await mkdir(join(quietRoot, 'src'), { recursive: true })
  await writeFile(join(quietRoot, 'src', 'main.txt'), 'quiet project content\n')
  await mkdir(join(agentRoot, 'docs'), { recursive: true })
  await writeFile(join(agentRoot, 'README.md'), '# Agent project\n')
  await writeFile(join(agentRoot, 'docs', 'notes.txt'), 'Notes for the agent\n')
  const shotPath = join(agentRoot, 'shot.png')
  await writeFile(shotPath, png(96, 64))
  const quietBefore = await listFiles(quietRoot)
  const agentBefore = await listFiles(agentRoot)
  const secureUrl = 'https://example.com/spade-live'
  const codeword = `MARIGOLD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

  // B1: two projects with different content.
  let spade = await launchLive(userData)
  let { app, page } = spade
  const empty = page.getByTestId('empty-state')
  await pickNext(app, quietRoot)
  await empty.getByRole('button', { name: 'Open project…' }).click()
  await expect(projectButton(page, basename(quietRoot))).toHaveAttribute('aria-current', 'page')
  const quietProjectId = (await state(page)).selectedProjectId!
  await createNoteFromToolbar(page, { title: 'Quiet note', body: 'Only in the quiet project' })

  await pickNext(app, agentRoot)
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Open project…' }).click()
  await expect(projectButton(page, basename(agentRoot))).toHaveAttribute('aria-current', 'page')
  const projectId = (await state(page)).selectedProjectId!
  expect(projectId).not.toBe(quietProjectId)
  await expect(canvasNode(page, 'Quiet note')).toHaveCount(0)

  // B3: an agent spawned through the New node form, in the project root.
  const prompt = [
    'This is an automated acceptance test of SPADE. Do exactly these numbered steps, in order, and nothing else.',
    'Do not create, edit, or delete any files.',
    '1. Use your Agent tool (also called Task) exactly once to launch one sub-agent whose only job is to reply with the single word PONG without using any tools. Wait for its answer.',
    '2. Run the SPADE CLI `skill` command described at the end of this message and read its output.',
    '3. Run the SPADE CLI `tree` command.',
    '4. Run the SPADE CLI command: spawn note --title "Live finding" --body "First note"',
    '   Give it no target, so the note becomes your own child. Remember the node id it prints.',
    '5. Run the SPADE CLI command: spawn note --parent <the Live finding node id> --title "Live detail" --body "Second note"',
    '6. Run the SPADE CLI command: spawn note --new-tree --title "Live loose" --body "Third note"',
    '   Then run the SPADE CLI command: reparent <the Live loose node id> <the Live finding node id>',
    '7. Finish with a final message that contains exactly these four lines and nothing else:',
    'docs/notes.txt',
    shotPath,
    secureUrl,
    pageUrl
  ].join('\n')
  await page.getByRole('toolbar', { name: 'Canvas' }).getByRole('button', { name: 'New node' }).click()
  await page.getByRole('menu', { name: 'New node' }).getByRole('menuitem', { name: 'Agent' }).click()
  const form = page.getByRole('dialog', { name: 'New agent' })
  await expect(form.getByLabel('Provider', { exact: true })).toBeEnabled({ timeout: 60_000 })
  await form.getByLabel('Provider', { exact: true }).selectOption('claude')
  await form.getByLabel('Model', { exact: true }).selectOption(MODEL)
  await form.getByLabel('Mode', { exact: true }).selectOption(MODE)
  await form.getByLabel('Prompt', { exact: true }).fill(prompt)
  await form.getByLabel('Title', { exact: true }).fill(AGENT_TITLE)
  await form.getByRole('button', { name: 'Create' }).click()
  await expect(form).toBeHidden({ timeout: 60_000 })
  await expect(canvasNode(page, AGENT_TITLE)).toBeVisible()

  let canvas = await readCanvas(page, projectId)
  const agentNode = nodeTitled(canvas, AGENT_TITLE)
  const agentId = agentNode.resourceRef!.id
  createdAgentIds.add(agentId)
  expect(agentNode.resourceRef).toMatchObject({ provider: 'paseo', kind: 'agent' })
  expect((agentNode.config as { prompt: string }).prompt).toBe(prompt)
  await expect.poll(async () => (await runtimeOf(page, projectId, agentNode.id))?.cwd).toBe(agentRoot)

  const allowed = await driveTurn(page, projectId, agentNode.id, (items) =>
    assistantTexts(items).some((text) => text.includes(secureUrl) && text.includes(pageUrl))
  )
  console.log(`Answered ${allowed} permission request(s) through the Allow button`)

  // The turn: the CLI calls and the sub-agent appear in the conversation.
  const items = await conversationOf(page, agentNode.id)
  expect(items.some((item) => item.kind === 'user-message' && item.text.startsWith(prompt))).toBe(true)
  const tools = items.flatMap((item) => (item.kind === 'tool-call' ? [item] : []))
  expect(tools.some((tool) => tool.toolKind === 'subagent')).toBe(true)
  expect(tools.some((tool) => tool.toolKind === 'shell' && /\bskill\b/.test(tool.summary))).toBe(true)
  expect(tools.some((tool) => tool.toolKind === 'shell' && /\btree\b/.test(tool.summary))).toBe(true)

  // The three notes, with the expected parent relations, every change attributed to the agent.
  canvas = await readCanvas(page, projectId)
  const tree = indexTree(canvas)
  const finding = nodeTitled(canvas, 'Live finding')
  const detail = nodeTitled(canvas, 'Live detail')
  const loose = nodeTitled(canvas, 'Live loose')
  expect(tree.parentOf(finding.id)).toBe(agentNode.id)
  expect(tree.parentOf(detail.id)).toBe(finding.id)
  expect(tree.parentOf(loose.id)).toBe(finding.id)
  const byAgent = canvas.activity.filter((entry) => entry.actor.kind === 'agent')
  for (const entry of byAgent) expect(entry.actor).toEqual({ kind: 'agent', nodeId: agentNode.id, agentId })
  for (const [command, nodeId] of [
    ['spawnChild', finding.id],
    ['spawnChild', detail.id],
    ['spawnChild', loose.id],
    ['reparent', loose.id]
  ] as const) {
    expect(byAgent.some((entry) => entry.command === command && entry.nodeIds.includes(nodeId)), `${command} of ${nodeId} by the agent`).toBe(true)
  }
  for (const node of [finding, detail, loose]) {
    expect(canvas.activity.filter((entry) => entry.nodeIds.includes(node.id) && entry.actor.kind !== 'agent')).toEqual([])
  }
  // The agent's own node was never duplicated.
  expect(canvas.nodes.filter((node) => node.resourceRef?.id === agentId)).toHaveLength(1)

  // The sub-agent: Claude's Agent tool is a provider-native sub-agent, listed in the node and opened as a child.
  await expect.poll(async () => (await runtimeOf(page, projectId, agentNode.id))?.providerSubagents.length ?? 0).toBeGreaterThan(0)
  let body = await showNode(page, AGENT_TITLE)
  await body.getByRole('button', { name: /Sub-agents/ }).click()
  const subagentEntry = body.getByRole('listitem', { name: /^Sub-agent / }).first()
  await subagentEntry.getByRole('button', { name: 'Open as node' }).click()
  await expect
    .poll(async () => (await readCanvas(page, projectId)).nodes.filter((node) => node.resourceRef?.kind === 'provider-subagent').length)
    .toBe(1)
  canvas = await readCanvas(page, projectId)
  const subagentNode = canvas.nodes.find((node) => node.resourceRef?.kind === 'provider-subagent')!
  expect(indexTree(canvas).parentEdgeOf(subagentNode.id)).toMatchObject({ fromNodeId: agentNode.id, origin: 'delegated' })

  await fitAll(page)
  await page.screenshot({ path: join(SHOTS, '01-agent-tree.png') })

  // The Activity panel names the agent as the author of its changes.
  await page.getByRole('toolbar', { name: 'Canvas' }).getByRole('button', { name: 'Activity' }).click()
  const activity = page.getByTestId('activity-entry').and(page.locator('[data-actor="agent"]'))
  await expect(activity.first()).toBeVisible()
  expect(await activity.count()).toBeGreaterThanOrEqual(4)
  for (const name of await activity.locator('.activity-entry__name').allInnerTexts()) expect(name.trim()).toBe(AGENT_TITLE)
  await page.screenshot({ path: join(SHOTS, '04-activity-panel.png') })
  await page.getByRole('toolbar', { name: 'Canvas' }).getByRole('button', { name: 'Activity' }).click()

  // B5: the final answer's path, image, and links are actionable chips.
  body = await showNode(page, AGENT_TITLE)
  const log = body.getByTestId('agent-conversation')
  const answer = log.getByRole('article', { name: 'Agent message' }).last()
  const chip = (kind: string, text: string): Locator => answer.locator(`button[data-artifact-kind="${kind}"]`, { hasText: text })
  await expect(chip('path', 'docs/notes.txt')).toHaveAttribute('data-path-state', 'file')
  await expect(chip('image', shotPath)).toBeVisible()
  await expect(chip('url', secureUrl)).toBeVisible()
  await expect(chip('url', pageUrl)).toBeVisible()
  await answer.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(SHOTS, '02-conversation.png') })

  await chip('path', 'docs/notes.txt').click()
  let popover = page.getByRole('dialog', { name: 'Path actions' })
  await expect(popover.getByRole('button')).toHaveText(['Reveal in Explorer', 'Copy path'])
  await popover.getByRole('button', { name: 'Reveal in Explorer' }).click()
  await expect.poll(async () => (await shellCalls(app)).at(-1)).toEqual({ method: 'showItemInFolder', target: join(agentRoot, 'docs', 'notes.txt') })

  await chip('image', shotPath).click()
  popover = page.getByRole('dialog', { name: 'Image actions' })
  await expect(popover.getByRole('button')).toHaveText(['Enlarge', 'Spawn as Image node…', 'Reveal in Explorer', 'Copy path'])
  await popover.getByRole('button', { name: 'Reveal in Explorer' }).click()
  await expect.poll(async () => (await shellCalls(app)).at(-1)).toEqual({ method: 'showItemInFolder', target: shotPath })

  await chip('url', secureUrl).click()
  popover = page.getByRole('dialog', { name: 'Link actions' })
  await expect(popover.getByRole('button')).toHaveText(['Spawn as Web page node…', 'Open in browser', 'Copy link'])
  await popover.getByRole('button', { name: 'Open in browser' }).click()
  await expect.poll(async () => (await shellCalls(app)).at(-1)).toEqual({ method: 'openExternal', target: secureUrl })

  // Spawn the image into a chosen tree (the Live finding branch), and the local page as a child of the agent.
  await chip('image', shotPath).click()
  await page.getByRole('dialog', { name: 'Image actions' }).getByRole('button', { name: 'Spawn as Image node…' }).click()
  let spawn = page.getByRole('dialog', { name: `Spawn image from ${AGENT_TITLE}` })
  await spawn.getByRole('radio', { name: 'Pick a tree or node' }).check()
  await spawn.getByRole('treeitem', { name: 'Live finding', exact: true }).click()
  await spawn.getByRole('radio', { name: 'Attach to this node' }).check()
  await spawn.getByRole('button', { name: 'Create' }).click()
  await expect(spawn).toBeHidden()

  await showNode(page, AGENT_TITLE)
  await chip('url', pageUrl).click()
  await page.getByRole('dialog', { name: 'Link actions' }).getByRole('button', { name: 'Spawn as Web page node…' }).click()
  spawn = page.getByRole('dialog', { name: `Spawn web page from ${AGENT_TITLE}` })
  await spawn.getByRole('button', { name: 'Create' }).click()
  await expect(spawn).toBeHidden()

  canvas = await readCanvas(page, projectId)
  const imageNode = canvas.nodes.find((node) => node.entityType === 'image')!
  const webNode = canvas.nodes.find((node) => node.entityType === 'webpage')!
  expect(imageNode.config).toMatchObject({ source: { kind: 'path', path: shotPath } })
  expect(indexTree(canvas).parentEdgeOf(imageNode.id)).toMatchObject({ fromNodeId: finding.id, origin: 'artifact', sourceArtifact: { kind: 'image' } })
  expect(webNode.config).toEqual({ url: pageUrl })
  expect(indexTree(canvas).parentEdgeOf(webNode.id)).toMatchObject({
    fromNodeId: agentNode.id,
    origin: 'artifact',
    sourceArtifact: { kind: 'url', value: pageUrl }
  })

  // B4: the image displays and the page loads.
  const expectViewers = async (current: Page, currentApp: ElectronApplication): Promise<void> => {
    await fitAll(current)
    await nodeMenu(current, imageNode.title, 'Fit')
    const view = canvasNode(current, imageNode.title).getByTestId('image-view')
    await expect.poll(() => view.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(96)
    await fitAll(current)
    await nodeMenu(current, webNode.title, 'Fit')
    await expect(canvasNode(current, webNode.title).getByTestId('webpage-guest')).toBeVisible()
    await expect
      .poll(() =>
        currentApp.evaluate(({ webContents }) =>
          webContents
            .getAllWebContents()
            .filter((contents) => contents.getType() === 'webview' && !contents.isDestroyed())
            .map((contents) => contents.getTitle())
        )
      )
      .toContain('SPADE live page')
  }
  await expectViewers(page, app)
  await page.screenshot({ path: join(SHOTS, '06-webpage-node.png') })
  await fitAll(page)
  await nodeMenu(page, imageNode.title, 'Fit')
  await page.screenshot({ path: join(SHOTS, '05-image-node.png') })

  // B1: switching keeps each canvas's own content.
  await projectButton(page, basename(quietRoot)).click()
  await expect(canvasNode(page, 'Quiet note')).toBeVisible()
  await expect(canvasNode(page, AGENT_TITLE)).toHaveCount(0)
  await projectButton(page, basename(agentRoot)).click()
  await expect(canvasNode(page, AGENT_TITLE)).toBeVisible()
  await expect(canvasNode(page, 'Quiet note')).toHaveCount(0)

  // Restart reconciliation: quit and relaunch over the same data while the daemon keeps running.
  const before = snapshotOf(await readCanvas(page, projectId))
  const quietBeforeRelaunch = snapshotOf(await readCanvas(page, quietProjectId))
  await app.close()
  running = null

  spade = await launchLive(userData)
  ;({ app, page } = spade)
  await expect(projectButton(page, basename(quietRoot))).toBeVisible()
  await expect(projectButton(page, basename(agentRoot))).toHaveAttribute('aria-current', 'page')
  await expect.poll(async () => (await runtimeOf(page, projectId, agentNode.id))?.resourceState, { timeout: 60_000 }).toBe('live')
  await expect.poll(async () => (await runtimeOf(page, projectId, agentNode.id))?.activity).toBe('idle')
  // Reconciliation has had its sweep; nothing was added, removed, or duplicated.
  await page.waitForTimeout(3_000)
  expect(snapshotOf(await readCanvas(page, projectId))).toEqual(before)
  expect(snapshotOf(await readCanvas(page, quietProjectId))).toEqual(quietBeforeRelaunch)
  expect(assistantTexts(await conversationOf(page, agentNode.id)).some((text) => text.includes(pageUrl))).toBe(true)
  body = await showNode(page, AGENT_TITLE)
  await expect(body.getByTestId('agent-conversation').getByRole('article', { name: 'Agent message' }).last()).toContainText(secureUrl)
  await expectViewers(page, app)
  await fitAll(page)
  await page.screenshot({ path: join(SHOTS, '07-after-relaunch.png') })

  // A follow-up from the composer with one attached context node the agent has not seen.
  await page.getByRole('toolbar', { name: 'Canvas' }).getByRole('button', { name: 'New node' }).click()
  await page.getByRole('menu', { name: 'New node' }).getByRole('menuitem', { name: 'Note' }).click()
  const noteForm = page.getByRole('dialog', { name: 'New note' })
  await noteForm.getByLabel('Title', { exact: true }).fill('Codeword')
  await noteForm.getByLabel('Text', { exact: true }).fill(`The codeword is ${codeword}.`)
  await noteForm.getByRole('radio', { name: 'Pick a tree or node' }).check()
  await noteForm.getByRole('treeitem', { name: AGENT_TITLE, exact: true }).click()
  await noteForm.getByRole('radio', { name: 'Attach to this node' }).check()
  await noteForm.getByRole('button', { name: 'Create' }).click()
  await expect(noteForm).toBeHidden()

  body = await showNode(page, AGENT_TITLE)
  await body.getByRole('button', { name: 'Attach context' }).click()
  const picker = page.getByRole('dialog', { name: 'Attach context' })
  await picker.getByRole('checkbox', { name: /Codeword/ }).check()
  await page.keyboard.press('Escape')
  await activate(page, AGENT_TITLE)
  await expect(body.getByRole('list', { name: 'Shared with the agent' }).getByRole('listitem')).toHaveText([/Codeword/])
  const input = body.getByRole('textbox', { name: 'Message' })
  await input.fill('Using only the attached context, reply with the codeword it contains and nothing else. Do not run any commands.')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await driveTurn(page, projectId, agentNode.id, (conversation) => {
    const texts = assistantTexts(conversation)
    return texts.length > 0 && texts.at(-1)!.includes(codeword)
  })
  const followUp = (await conversationOf(page, agentNode.id)).filter((item) => item.kind === 'user-message').at(-1)
  expect(followUp?.kind === 'user-message' && followUp.text).toContain(codeword)
  canvas = await readCanvas(page, projectId)
  expect(canvas.nodes.filter((node) => node.resourceRef?.id === agentId)).toHaveLength(1)
  await page.screenshot({ path: join(SHOTS, '08-follow-up.png') })
  await app.close()
  running = null

  // No file was created by SPADE in either directory.
  expect(await listFiles(quietRoot)).toEqual(quietBefore)
  const agentAfter = await listFiles(agentRoot)
  for (const [path, digest] of agentBefore) expect(agentAfter.get(path), path).toBe(digest)
  expect([...agentAfter.keys()].filter((path) => /(^|[\\/])\.?spade|\.gitignore$|\.git([\\/]|$)/i.test(path))).toEqual([])
})
