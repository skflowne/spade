import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { PREVIEW_ZOOM_THRESHOLD } from '../../src/renderer/src/canvas/model/levelOfDetail'
import type { AgentRuntime, ConversationItem } from '../../src/shared/agents'
import { indexTree } from '../../src/shared/tree'
import {
  agentCalls,
  installAgentScript,
  items,
  png,
  pushRuntime,
  runtimeFor,
  scriptFiles,
  setProviders,
  setReply,
  setTimeline,
  shellCalls
} from './agent-harness'
import {
  appState,
  canvasNode,
  execute,
  fitAll,
  launch,
  nodeBody,
  nodeHeader,
  nodeMenu,
  openProjectFromSidebar,
  readCanvas,
  renderedViewport,
  scratchDirectory,
  selectedProjectId,
  type Spade
} from './ui-harness'

let scratch: string

test.beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'spade-agent-ui-'))
})

test.afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

type Session = Spade & { projectId: string; projectRoot: string }

async function launchScripted(prepare?: (root: string) => Promise<void>): Promise<Session> {
  const projectRoot = await scratchDirectory(scratch, 'project')
  await prepare?.(projectRoot)
  const spade = await launch(await scratchDirectory(scratch, 'user-data'))
  await installAgentScript(spade.app)
  await openProjectFromSidebar(spade, projectRoot)
  await expect(spade.page.getByTestId('canvas')).toBeVisible()
  return { ...spade, projectId: await selectedProjectId(spade.page), projectRoot }
}

// An agent node whose Paseo agent already exists, so no adapter runs; its runtime and timeline are scripted.
async function seedAgent(session: Session, title = 'Agent', config: Record<string, unknown> = {}): Promise<string> {
  const response = await execute(session.page, {
    type: 'startTree',
    node: {
      entityType: 'agent',
      config: { provider: 'claude', model: 'opus', mode: 'default', prompt: 'Start', ...config },
      title,
      resourceRef: { provider: 'paseo', kind: 'agent', id: 'fake-1' }
    }
  })
  if (!response.ok || !response.nodeId) throw new Error(JSON.stringify(response))
  await expect(canvasNode(session.page, title)).toBeVisible()
  return response.nodeId
}

async function showAgent(session: Session, nodeId: string, conversation: ConversationItem[], runtime: Partial<AgentRuntime> = {}): Promise<void> {
  await pushRuntime(session.app, runtimeFor(session.projectId, nodeId, runtime))
  await setTimeline(session.app, nodeId, { epoch: 'e1', items: conversation, olderCursor: null })
}

async function activate(page: Page, title: string): Promise<Locator> {
  const body = nodeBody(page, title)
  await nodeHeader(page, title).click({ position: { x: 60, y: 10 } })
  await body.click({ position: { x: 8, y: 8 } })
  await expect(body).toHaveAttribute('data-active', 'true')
  return body
}

function conversation(page: Page, title: string): Locator {
  return nodeBody(page, title).getByTestId('agent-conversation')
}

test('renders every conversation item kind', async () => {
  const session = await launchScripted()
  const { page } = session
  try {
    const nodeId = await seedAgent(session)
    await showAgent(session, nodeId, [
      items.user('u1', 'Please look at the parser'),
      items.user('u2', 'Child finished', { agentId: 'child-1', title: 'Reviewer' }),
      items.thinking('t1', 'Considering the grammar\nsecond line'),
      items.tool('s1', { toolKind: 'shell', name: 'Bash', summary: 'npm test', input: 'npm test', output: '12 passed' }),
      items.tool('r1', { toolKind: 'read', name: 'Read', summary: 'src/parser.ts', path: 'src/parser.ts', output: 'export const parse = 1' }),
      items.tool('e1', { toolKind: 'edit', name: 'Edit', summary: 'src/parser.ts', path: 'src/parser.ts', diff: '@@ -1 +1 @@\n-old line\n+new line' }),
      items.tool('q1', { toolKind: 'search', name: 'Grep', summary: 'parse(', input: 'parse(', output: 'src/parser.ts:1' }),
      items.tool('f1', { toolKind: 'fetch', name: 'WebFetch', summary: 'https://example.com', status: 'failed', error: 'timed out' }),
      items.tool('o1', { toolKind: 'other', name: 'Custom', summary: 'did a thing', status: 'running' }),
      items.todo('d1', [
        { text: 'Read the parser', done: true },
        { text: 'Fix the bug', done: false }
      ]),
      items.error('x1', 'The provider rejected the request'),
      items.notice('n1', 'Context compacted'),
      items.assistant('a1', '## Findings\n\nThe parser is **fine**.\n\n```ts\nconst a = 1\n```')
    ])
    const log = conversation(page, 'Agent')
    await expect(log.getByRole('article', { name: 'Your message' })).toContainText('Please look at the parser')
    await expect(log.getByRole('article', { name: 'Message from Reviewer' })).toContainText('From Reviewer')
    await expect(log.getByRole('article', { name: 'Agent message' }).getByRole('heading', { name: 'Findings' })).toBeVisible()
    await expect(log.locator('[data-item-kind="todo"]')).toContainText('Fix the bug')
    await expect(log.locator('[data-item-kind="error"]')).toContainText('The provider rejected the request')
    await expect(log.locator('[data-item-kind="notice"]')).toContainText('Context compacted')

    const panes = log.getByTestId('conversation-pane')
    await expect(panes).toHaveCount(7)
    const shell = panes.and(page.locator('[data-tool-kind="shell"]'))
    await expect(shell).toContainText('$ npm test')
    await expect(shell).toContainText('12 passed')
    await expect(shell.getByText('completed')).toBeVisible()
    const edit = panes.and(page.locator('[data-tool-kind="edit"]'))
    await expect(edit.locator('.hljs-addition')).toHaveText('+new line')
    await expect(edit.locator('.hljs-deletion')).toHaveText('-old line')
    await expect(edit.locator('button.rich-artifact', { hasText: 'src/parser.ts' }).first()).toBeVisible()
    await expect(panes.and(page.locator('[data-tool-kind="fetch"]'))).toContainText('timed out')
    await expect(panes.and(page.locator('[data-tool-kind="fetch"]')).getByText('failed')).toBeVisible()
    await expect(panes.and(page.locator('[data-tool-kind="other"]')).getByText('running')).toBeVisible()

    // Header status: activity with provider, model, and mode.
    await expect(canvasNode(page, 'Agent').getByTestId('agent-status')).toContainText('idle')
    await expect(canvasNode(page, 'Agent').getByTestId('agent-status').locator('.cr-badge').first()).toHaveAttribute(
      'title',
      /claude · opus · default/
    )
  } finally {
    await session.app.close()
  }
})

const PROVIDERS = [
  { id: 'codex', label: 'Codex', available: false, status: 'error' as const, error: 'not installed', models: [], modes: [], defaultModeId: null },
  {
    id: 'claude',
    label: 'Claude',
    available: true,
    status: 'ready' as const,
    error: null,
    models: [
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'opus', label: 'Opus', isDefault: true }
    ],
    modes: [
      { id: 'default', label: 'Default' },
      { id: 'plan', label: 'Plan' }
    ],
    defaultModeId: 'plan'
  }
]

test('the spawn form lists Paseo providers, explains an unreachable Paseo, and remembers the last choice', async () => {
  const session = await launchScripted()
  const { page, app } = session
  try {
    const openForm = async (): Promise<Locator> => {
      await page.getByRole('toolbar', { name: 'Canvas' }).getByRole('button', { name: 'New node' }).click()
      await page.getByRole('menu', { name: 'New node' }).getByRole('menuitem', { name: 'Agent' }).click()
      return page.getByRole('dialog', { name: 'New agent' })
    }
    let dialog = await openForm()
    await expect(dialog.getByRole('alert')).toContainText('Paseo is disabled for this session')
    await expect(dialog.getByText(session.projectRoot)).toBeVisible()

    await setProviders(app, { providers: PROVIDERS })
    await dialog.getByRole('button', { name: 'Retry' }).click()
    const provider = dialog.getByLabel('Provider', { exact: true })
    await expect(provider).toHaveValue('claude')
    await expect(provider.locator('option', { hasText: 'Codex — not installed' })).toBeDisabled()
    // No saved defaults yet: the provider's own default model and mode.
    await expect(dialog.getByLabel('Model', { exact: true })).toHaveValue('opus')
    await expect(dialog.getByLabel('Mode', { exact: true })).toHaveValue('plan')

    await dialog.getByLabel('Model', { exact: true }).selectOption('sonnet')
    await dialog.getByLabel('Mode', { exact: true }).selectOption('default')
    await dialog.getByLabel('Prompt', { exact: true }).fill('Refactor the parser')
    await dialog.getByRole('button', { name: 'Create' }).click()
    // The spawn itself reaches the real agent service, which has no Paseo in UI specs.
    await expect(dialog.getByRole('alert')).toContainText('Could not create the agent')
    await expect.poll(async () => (await appState(page)).settings.agentDefaults).toEqual({ provider: 'claude', model: 'sonnet', mode: 'default' })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('region', { name: 'Notices' }).getByRole('button', { name: 'Dismiss' }).click()

    dialog = await openForm()
    await expect(dialog.getByLabel('Model', { exact: true })).toHaveValue('sonnet')
    await expect(dialog.getByLabel('Mode', { exact: true })).toHaveValue('default')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
  } finally {
    await app.close()
  }
})

test('pane expansion follows the preferences, a per-conversation override, and per-pane toggles', async () => {
  const session = await launchScripted()
  const { page } = session
  try {
    const nodeId = await seedAgent(session)
    await showAgent(session, nodeId, [
      items.thinking('t1', 'Thinking it over'),
      items.tool('r1', { toolKind: 'read', name: 'Read', summary: 'a.txt', output: 'file content' }),
      items.tool('s1', { toolKind: 'shell', name: 'Bash', summary: 'ls', output: 'listing' }),
      items.assistant('a1', '```spade-html Choice\n<!doctype html><p>Pick one</p>\n```')
    ])
    const log = conversation(page, 'Agent')
    const toggle = (kind: string): Locator => log.locator(`[data-pane-kind="${kind}"] .agent-pane__toggle`)
    // Defaults: everything expanded except file reads.
    await expect(toggle('read')).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle('toolCall')).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle('thinking')).toHaveAttribute('aria-expanded', 'true')
    await expect(log.getByTestId('html-answer')).toHaveAttribute('data-expanded', 'true')

    const body = await activate(page, 'Agent')
    // Toggling one pane changes neither the conversation's override nor the global default.
    await toggle('toolCall').click()
    await expect(toggle('toolCall')).toHaveAttribute('aria-expanded', 'false')
    await expect(log.getByText('listing')).toBeHidden()

    await body.getByRole('button', { name: 'Panes' }).click()
    const panes = page.getByRole('dialog', { name: 'Expanded panes' })
    await panes.getByRole('checkbox', { name: 'File reads' }).check()
    await expect.poll(async () => (await readCanvas(page)).nodes.find((node) => node.id === nodeId)!.config).toMatchObject({
      provider: 'claude',
      prompt: 'Start',
      expansion: { read: true }
    })
    await expect(toggle('read')).toHaveAttribute('aria-expanded', 'true')
    await panes.getByRole('checkbox', { name: 'HTML answers' }).uncheck()
    await expect(log.getByTestId('html-answer')).toHaveAttribute('data-expanded', 'false')
    await expect(log.locator('iframe')).toHaveCount(0)
    // The pane the user toggled keeps the user's choice.
    await expect(toggle('toolCall')).toHaveAttribute('aria-expanded', 'false')
    await expect(panes.getByText('this conversation', { exact: true })).toHaveCount(2)

    await panes.getByRole('button', { name: 'Use defaults' }).click()
    await expect.poll(async () => (await readCanvas(page)).nodes.find((node) => node.id === nodeId)!.config).not.toHaveProperty('expansion')
    await expect(toggle('read')).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('Escape')
    await expect(panes).toBeHidden()
    expect((await appState(page)).settings.conversationExpansion).toEqual({ toolCall: true, diff: true, html: true, thinking: true, read: false })
  } finally {
    await session.app.close()
  }
})

test('a streaming update keeps earlier rich blocks mounted, older pages load on request, and scrolling is respected', async () => {
  const session = await launchScripted()
  const { page, app } = session
  try {
    const nodeId = await seedAgent(session)
    const filler = Array.from({ length: 40 }, (_, index) => items.notice(`n${index}`, `Filler notice ${index}`))
    const answer = '```spade-html Live\n<!doctype html><p>Live answer</p>\n```'
    await pushRuntime(app, runtimeFor(session.projectId, nodeId, { activity: 'running', status: 'running' }))
    await setTimeline(
      app,
      nodeId,
      { epoch: 'e1', olderCursor: 'cursor-1', items: [...filler, items.assistant('a1', `${answer}\n\nStreaming`)] },
      { 'cursor-1': { epoch: 'e1', olderCursor: null, items: [items.user('old', 'The very first message')] } }
    )
    const log = conversation(page, 'Agent')
    const frame = log.locator('iframe.rich-html__frame')
    await expect(page.frameLocator('iframe.rich-html__frame').getByText('Live answer')).toBeVisible()
    const token = await frame.getAttribute('data-runtime-token')
    await frame.evaluate((element: HTMLIFrameElement) => {
      ;(element.contentWindow as unknown as { mark: number }).mark = 1
    })

    // Stuck to the bottom: the streamed text follows.
    await setTimeline(app, nodeId, {
      epoch: 'e1',
      olderCursor: 'cursor-1',
      items: [...filler, items.assistant('a1', `${answer}\n\nStreaming more text`)]
    })
    await expect(log.getByText('Streaming more text')).toBeVisible()
    await expect.poll(() => log.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(4)
    expect(await frame.getAttribute('data-runtime-token')).toBe(token)
    expect(await frame.evaluate((element: HTMLIFrameElement) => (element.contentWindow as unknown as { mark?: number }).mark)).toBe(1)

    // Scrolled up: new content never moves the view.
    await log.evaluate(
      (element) =>
        new Promise<void>((resolve) => {
          element.addEventListener('scroll', () => resolve(), { once: true })
          element.scrollTop = 0
        })
    )
    await setTimeline(app, nodeId, {
      epoch: 'e1',
      olderCursor: 'cursor-1',
      items: [...filler, items.assistant('a1', `${answer}\n\nStreaming more text, done.`), items.notice('n-last', 'Turn finished')]
    })
    await expect(log.getByText('Turn finished')).toBeAttached()
    expect(await log.evaluate((element) => element.scrollTop)).toBe(0)

    await activate(page, 'Agent')
    await log.getByRole('button', { name: 'Load older messages' }).click()
    await expect(log.getByRole('article', { name: 'Your message' })).toContainText('The very first message')
    await expect(log.getByRole('button', { name: 'Load older messages' })).toHaveCount(0)
    expect(await agentCalls(app, 'agents.getTimeline')).toContainEqual([nodeId, { before: 'cursor-1' }])

    // A new epoch replaces everything, including the older page.
    await setTimeline(app, nodeId, { epoch: 'e2', olderCursor: null, items: [items.assistant('b1', 'After a daemon restart')] })
    await expect(log.getByText('After a daemon restart')).toBeVisible()
    await expect(log.getByText('The very first message')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a failed request for older messages leaves the scroll position alone', async () => {
  const session = await launchScripted()
  const { page, app } = session
  try {
    const nodeId = await seedAgent(session)
    const filler = Array.from({ length: 40 }, (_, index) => items.notice(`n${index}`, `Filler notice ${index}`))
    // No older page is scripted for cursor-1: the request fails.
    await setTimeline(app, nodeId, { epoch: 'e1', olderCursor: 'cursor-1', items: filler })
    await pushRuntime(app, runtimeFor(session.projectId, nodeId))
    const log = conversation(page, 'Agent')
    await expect(log.getByText('Filler notice 39')).toBeVisible()
    await activate(page, 'Agent')
    const scrollToTop = (): Promise<void> =>
      log.evaluate(
        (element) =>
          new Promise<void>((resolve) => {
            if (element.scrollTop === 0) return resolve()
            element.addEventListener('scroll', () => resolve(), { once: true })
            element.scrollTop = 0
          })
      )
    await scrollToTop()
    await log.getByRole('button', { name: 'Load older messages' }).click()
    await expect(nodeBody(page, 'Agent').getByTestId('agent-state')).toContainText('Could not load the conversation')
    await setTimeline(app, nodeId, { epoch: 'e1', olderCursor: 'cursor-1', items: [...filler, items.notice('late', 'Late notice')] })
    await expect(log.getByText('Late notice')).toBeAttached()
    expect(await log.evaluate((element) => element.scrollTop)).toBe(0)
  } finally {
    await app.close()
  }
})

test('collapsing or zooming out keeps the draft, shared context, annotations, history, and scroll position', async () => {
  const session = await launchScripted()
  const { page, app } = session
  try {
    const nodeId = await seedAgent(session)
    await execute(page, { type: 'spawnChild', sourceNodeId: nodeId, origin: 'spawned', node: { entityType: 'note', config: { body: '' }, title: 'Spec' } })
    const filler = Array.from({ length: 30 }, (_, index) => items.notice(`n${index}`, `Filler notice ${index}`))
    const answer = '```spade-html Review\n<!doctype html><button onclick="window.spade.annotate({ text: \'Check this\' })">Note</button>\n```'
    await pushRuntime(app, runtimeFor(session.projectId, nodeId))
    await setTimeline(
      app,
      nodeId,
      { epoch: 'e1', olderCursor: 'cursor-1', items: [...filler, items.assistant('a0', answer), items.assistant('a1', 'Final answer text')] },
      { 'cursor-1': { epoch: 'e1', olderCursor: null, items: [items.user('old', 'The very first message')] } }
    )
    const log = conversation(page, 'Agent')
    const body = await activate(page, 'Agent')
    const input = body.getByRole('textbox', { name: 'Message' })
    await input.fill('Half-written thought')
    await body.getByRole('button', { name: 'Attach context' }).click()
    await page.getByRole('dialog', { name: 'Attach context' }).getByRole('checkbox', { name: /Spec/ }).check()
    await page.keyboard.press('Escape')
    await page.frameLocator('iframe.rich-html__frame').getByRole('button', { name: 'Note' }).click()
    await expect(log.getByRole('region', { name: 'Pending annotations' })).toContainText('Check this')
    await log.getByRole('button', { name: 'Load older messages' }).click()
    await expect(log.getByText('The very first message')).toBeAttached()
    await log.evaluate(
      (element) =>
        new Promise<void>((resolve) => {
          element.addEventListener('scroll', () => resolve(), { once: true })
          element.scrollTop = 150
        })
    )

    const remembered = async (): Promise<void> => {
      await expect(input).toHaveValue('Half-written thought')
      await expect(body.getByRole('list', { name: 'Shared with the agent' }).getByRole('listitem')).toHaveText([/child\s*Spec/])
      await expect(log.getByRole('region', { name: 'Pending annotations' })).toContainText('Check this')
      await expect(log.getByText('The very first message')).toBeAttached()
      await expect(log.getByRole('button', { name: 'Load older messages' })).toHaveCount(0)
      await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBe(150)
    }
    await execute(page, { type: 'collapseNode', nodeId })
    await expect(log).toHaveCount(0)
    await execute(page, { type: 'expandNode', nodeId })
    await remembered()

    const toolbar = page.getByRole('toolbar', { name: 'Canvas' })
    const zoom = async (direction: 'out' | 'in'): Promise<void> => {
      while (direction === 'out' ? (await renderedViewport(page)).zoom >= PREVIEW_ZOOM_THRESHOLD : (await renderedViewport(page)).zoom < PREVIEW_ZOOM_THRESHOLD) {
        await toolbar.getByRole('button', { name: direction === 'out' ? 'Zoom out' : 'Zoom in' }).click()
      }
    }
    const preview = canvasNode(page, 'Agent').getByTestId('agent-preview')
    await zoom('out')
    await expect(preview).toContainText('Final answer text')
    await zoom('in')
    await remembered()

    // The newest page now holds only tool calls. The preview keeps the last answer it knows, and crossing the
    // zoom threshold reads nothing again.
    await setTimeline(app, nodeId, {
      epoch: 'e1',
      olderCursor: 'cursor-3',
      items: [items.tool('r1', { toolKind: 'read', name: 'Read', summary: 'a.txt' }), items.tool('r2', { toolKind: 'read', name: 'Read', summary: 'b.txt' })]
    })
    await expect(log.locator('[data-tool-kind="read"]')).toHaveCount(2)
    const reads = (await agentCalls(app, 'agents.getTimeline')).length
    await zoom('out')
    await expect(preview).toContainText('Final answer text')
    await zoom('in')
    await expect(log.locator('[data-tool-kind="read"]')).toHaveCount(2)
    expect(await agentCalls(app, 'agents.getTimeline')).toHaveLength(reads)
  } finally {
    await app.close()
  }
})

test('without a reachable agent the conversation explains why and keeps what it has', async () => {
  const session = await launchScripted()
  const { page, app } = session
  try {
    const nodeId = await seedAgent(session)
    const body = nodeBody(page, 'Agent')
    await expect(body.getByTestId('agent-state')).toContainText('Waiting for the agent’s state from Paseo')
    await expect(body.getByRole('textbox', { name: 'Message' })).toBeDisabled()

    await showAgent(session, nodeId, [])
    await expect(body.getByText('No messages yet.')).toBeVisible()
    await expect(body.getByTestId('agent-state')).toHaveCount(0)

    await showAgent(session, nodeId, [items.assistant('a1', 'Cached answer')])
    await expect(body.getByText('Cached answer')).toBeVisible()
    await pushRuntime(app, runtimeFor(session.projectId, nodeId, { resourceState: 'stale' }))
    await expect(body.getByTestId('agent-state')).toContainText('Paseo unreachable')
    await expect(body.getByText('Cached answer')).toBeVisible()
    await expect(body.getByRole('textbox', { name: 'Message' })).toBeDisabled()
    await expect(body.getByText('Paseo is unreachable.')).toBeVisible()
    await expect(canvasNode(page, 'Agent').getByTestId('agent-status')).toContainText('stale')

    await execute(page, { type: 'spawnChild', sourceNodeId: nodeId, origin: 'spawned', node: { entityType: 'note', config: { body: '' }, title: 'Kept child' } })
    await pushRuntime(app, runtimeFor(session.projectId, nodeId, { resourceState: 'missing', activity: 'closed' }))
    await expect(body.getByTestId('agent-state')).toContainText('Paseo no longer has this agent')
    await expect(canvasNode(page, 'Agent').getByTestId('agent-status')).toContainText('missing')
    await expect(canvasNode(page, 'Kept child')).toBeVisible()
    expect((await readCanvas(page)).nodes.map((node) => node.title).sort()).toEqual(['Agent', 'Kept child'])
  } finally {
    await app.close()
  }
})

test('permissions, prompts with shared context, interrupting, and provider sub-agents go through the bridge', async () => {
  const session = await launchScripted()
  const { page, app } = session
  try {
    const nodeId = await seedAgent(session)
    const spec = await execute(page, { type: 'spawnChild', sourceNodeId: nodeId, origin: 'spawned', node: { entityType: 'note', config: { body: 'Spec text' }, title: 'Spec' } })
    const elsewhere = await execute(page, { type: 'startTree', node: { entityType: 'note', config: { body: '' }, title: 'Elsewhere' } })
    if (!spec.ok || !elsewhere.ok) throw new Error('seeding failed')
    await setReply(app, 'agents.openProviderSubagent', { ok: true, nodeId: spec.nodeId! })
    await showAgent(
      session,
      nodeId,
      [items.tool('sa', { toolKind: 'subagent', name: 'Task', summary: 'Explore the parser', callId: 'sub-1' })],
      {
        activity: 'running',
        status: 'running',
        pendingPermissions: [{ id: 'perm-1', kind: 'tool', name: 'Bash', title: 'Run npm install', description: 'Installs packages', detail: 'npm install' }],
        providerSubagents: [
          { id: 'sub-1', parentSubagentId: null, title: 'Explore', description: 'Explore the parser', status: 'running', updatedAt: '2026-01-01T00:00:00.000Z' }
        ]
      }
    )
    const status = canvasNode(page, 'Agent').getByTestId('agent-status')
    await expect(status).toContainText('needs attention')
    // The wrapper marks the node as waiting for the user, collapsed or not.
    await expect(canvasNode(page, 'Agent')).toHaveClass(/spade-node--attention/)
    await execute(page, { type: 'collapseNode', nodeId })
    await expect(status).toContainText('1 request')
    await expect(canvasNode(page, 'Agent')).toHaveClass(/spade-node--attention/)
    await execute(page, { type: 'expandNode', nodeId })

    const body = await activate(page, 'Agent')
    // Waiting for attention never hides that the node is the active one.
    const borderOf = (locator: Locator): Promise<string> => locator.evaluate((element) => getComputedStyle(element).borderTopColor)
    const accent = await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.borderTopColor = 'var(--accent)'
      document.body.append(probe)
      const color = getComputedStyle(probe).borderTopColor
      probe.remove()
      return color
    })
    await expect.poll(() => borderOf(canvasNode(page, 'Agent'))).toBe(accent)
    const request = body.getByRole('article', { name: 'Permission request: Run npm install' })
    await expect(request).toContainText('npm install')
    await request.getByRole('button', { name: 'Allow' }).click()
    await expect(request.getByRole('button', { name: 'Deny' })).toBeDisabled()
    expect(await agentCalls(app, 'agents.respondToPermission')).toEqual([[nodeId, 'perm-1', 'allow']])

    // Context: a connected child from the list, and a node picked on the canvas.
    await body.getByRole('button', { name: 'Attach context' }).click()
    const picker = page.getByRole('dialog', { name: 'Attach context' })
    await picker.getByRole('checkbox', { name: /Spec/ }).check()
    await picker.getByRole('button', { name: 'Pick a node…' }).click()
    await expect(page.getByTestId('picking-banner')).toBeVisible()
    await nodeHeader(page, 'Elsewhere').click()
    await expect(page.getByTestId('picking-banner')).toBeHidden()
    const shared = body.getByRole('list', { name: 'Shared with the agent' })
    await expect(shared.getByRole('listitem')).toHaveText([/child\s*Spec/, /picked\s*Elsewhere/])

    await activate(page, 'Agent')
    const input = body.getByRole('textbox', { name: 'Message' })
    await input.fill('Use these')
    await input.press('Shift+Enter')
    await input.pressSequentially('please')
    await input.press('Enter')
    await expect.poll(() => agentCalls(app, 'agents.prompt')).toEqual([
      [nodeId, { text: 'Use these\nplease', contextNodeIds: [spec.nodeId, elsewhere.nodeId] }]
    ])
    await expect(input).toHaveValue('')
    await expect(shared).toHaveCount(0)

    await setReply(app, 'agents.prompt', { ok: false, error: { code: 'paseo-failed', message: 'The agent is busy' } })
    await input.fill('Again')
    await body.getByRole('button', { name: 'Send' }).click()
    await expect(body.getByRole('alert')).toContainText('Could not send: The agent is busy')
    await expect(input).toHaveValue('Again')

    await body.getByRole('button', { name: 'Interrupt' }).click()
    await expect.poll(() => agentCalls(app, 'agents.interrupt')).toEqual([[nodeId]])
    await nodeMenu(page, 'Agent', 'Interrupt')
    await expect.poll(async () => (await agentCalls(app, 'agents.interrupt')).length).toBe(2)

    await activate(page, 'Agent')
    await body.getByRole('button', { name: /Sub-agents/ }).click()
    const entry = body.getByRole('listitem', { name: 'Sub-agent Explore' })
    await expect(entry).toContainText('Explore the parser')
    await entry.getByRole('button', { name: 'Open as node' }).click()
    await expect.poll(() => agentCalls(app, 'agents.openProviderSubagent')).toEqual([[nodeId, 'sub-1']])
    // The sub-agent's tool call links to the same action.
    await body.locator('[data-tool-kind="subagent"]').getByRole('button', { name: 'Open as node' }).click()
    await expect.poll(async () => (await agentCalls(app, 'agents.openProviderSubagent')).length).toBe(2)

    await nodeMenu(page, 'Agent', 'Copy agent id')
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('fake-1')
  } finally {
    await app.close()
  }
})

test('an agent message with a path, an image, and a URL offers every action', async () => {
  const session = await launchScripted(async (root) => {
    await writeFile(join(root, 'shot.png'), png(64, 48))
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'docs', 'notes.txt'), 'notes')
  })
  const { page, app, projectRoot } = session
  try {
    const nodeId = await seedAgent(session)
    const otherRoot = await execute(page, { type: 'startTree', node: { entityType: 'note', config: { body: '' }, title: 'Other root' } })
    if (!otherRoot.ok) throw new Error('seeding failed')
    await execute(page, { type: 'spawnChild', sourceNodeId: otherRoot.nodeId!, origin: 'spawned', node: { entityType: 'note', config: { body: '' }, title: 'Other leaf' } })
    await showAgent(session, nodeId, [
      items.assistant(
        'a1',
        'Read `docs/notes.txt` and the `docs/` folder. Screenshot: ![shot](shot.png)\n\n' +
          'Also `/nope/gone.txt` is gone, Deno/Node.js is prose, and see https://example.com/page.'
      )
    ])
    const log = conversation(page, 'Agent')
    const chip = (text: string): Locator => log.locator('button.rich-artifact').filter({ hasText: new RegExp(`^${escape(text)}$`) })

    // Lazy existence checks: a missing absolute path is disabled, a missing relative one is plain text.
    await expect(chip('/nope/gone.txt')).toHaveAttribute('aria-disabled', 'true')
    await expect(chip('Deno/Node.js')).toHaveAttribute('data-quiet', 'true')
    await expect(chip('docs/notes.txt')).toHaveAttribute('data-path-state', 'file')
    // The inline thumbnail is served by the main process.
    const thumbnail = log.locator('.rich-image img')
    await expect(thumbnail).toHaveAttribute('src', /^spade-image:/)
    await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(64)

    await activate(page, 'Agent')
    await chip('docs/notes.txt').click()
    let popover = page.getByRole('dialog', { name: 'Path actions' })
    await expect(popover.getByRole('button')).toHaveText(['Reveal in Explorer', 'Copy path'])
    await popover.getByRole('button', { name: 'Reveal in Explorer' }).click()
    await expect(popover).toBeHidden()

    await chip('docs/').click()
    popover = page.getByRole('dialog', { name: 'Path actions' })
    await expect(popover.getByRole('button')).toHaveText(['Open in Explorer', 'Copy path'])
    await popover.getByRole('button', { name: 'Open in Explorer' }).click()
    await expect(popover).toBeHidden()
    // A file is only ever revealed; only the folder is opened.
    await expect.poll(() => shellCalls(app)).toEqual([
      { method: 'showItemInFolder', target: join(projectRoot, 'docs', 'notes.txt') },
      { method: 'openPath', target: expect.stringMatching(new RegExp(`^${escape(join(projectRoot, 'docs'))}[\\\\/]?$`)) }
    ])

    // Missing paths offer nothing; the user can still click them.
    await chip('/nope/gone.txt').click({ force: true })
    await chip('Deno/Node.js').click({ force: true })
    await expect(page.getByRole('dialog', { name: 'Path actions' })).toHaveCount(0)
    // Escape closes a popover without leaving the conversation.
    await chip('docs/').click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Path actions' })).toBeHidden()
    await expect(nodeBody(page, 'Agent')).toHaveAttribute('data-active', 'true')
    await expect(chip('docs/')).toBeFocused()

    const image = log.getByRole('button', { name: 'Image: shot' })
    await image.click()
    popover = page.getByRole('dialog', { name: 'Image actions' })
    await expect(popover.getByRole('button')).toHaveText(['Enlarge', 'Spawn as Image node…', 'Reveal in Explorer', 'Copy path'])
    await popover.getByRole('button', { name: 'Enlarge' }).click()
    const lightbox = page.getByRole('dialog', { name: 'shot.png' })
    await expect(lightbox.getByRole('img')).toHaveAttribute('src', /^spade-image:/)
    // A click inside the lightbox stays there: it never activates the node behind it. Escape belongs to the
    // open dialog, so the node is deactivated the other way the canvas offers: a click on the empty pane.
    await page.evaluate(() =>
      document.querySelector('.react-flow__pane')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    )
    await expect(nodeBody(page, 'Agent')).toHaveAttribute('data-active', 'false')
    await lightbox.getByRole('img').click()
    await expect(lightbox).toBeVisible()
    await expect(nodeBody(page, 'Agent')).toHaveAttribute('data-active', 'false')
    await lightbox.getByRole('button', { name: 'Close' }).click()
    await expect(lightbox).toBeHidden()

    await activate(page, 'Agent')
    await image.click()
    await page.getByRole('dialog', { name: 'Image actions' }).getByRole('button', { name: 'Reveal in Explorer' }).click()
    await expect.poll(async () => (await shellCalls(app)).at(-1)).toEqual({ method: 'showItemInFolder', target: join(projectRoot, 'shot.png') })

    // Spawn as Image node: attached to a chosen tree's root, then as a new tree.
    await activate(page, 'Agent')
    await image.click()
    await page.getByRole('dialog', { name: 'Image actions' }).getByRole('button', { name: 'Spawn as Image node…' }).click()
    let spawn = page.getByRole('dialog', { name: 'Spawn image from Agent' })
    await spawn.getByRole('radio', { name: 'Pick a tree or node' }).check()
    await spawn.getByRole('treeitem', { name: 'Other leaf', exact: true }).click()
    await spawn.getByRole('radio', { name: 'Attach to its tree\'s root' }).check()
    await spawn.getByRole('button', { name: 'Create' }).click()
    await expect(spawn).toBeHidden()

    // Spawning centers the new node; bring the conversation back at a zoom that shows its full body.
    await fitAll(page)
    await nodeMenu(page, 'Agent', 'Fit')
    await activate(page, 'Agent')
    await image.click()
    await page.getByRole('dialog', { name: 'Image actions' }).getByRole('button', { name: 'Spawn as Image node…' }).click()
    spawn = page.getByRole('dialog', { name: 'Spawn image from Agent' })
    await spawn.getByRole('radio', { name: 'Start a new tree' }).check()
    await spawn.getByRole('button', { name: 'Create' }).click()
    await expect(spawn).toBeHidden()

    let canvas = await readCanvas(page)
    const images = canvas.nodes.filter((node) => node.entityType === 'image')
    expect(images).toHaveLength(2)
    for (const node of images) expect(node.config).toEqual({ source: { kind: 'path', path: join(projectRoot, 'shot.png') } })
    const tree = indexTree(canvas)
    const [attached, rooted] = images
    expect(tree.parentOf(attached.id)).toBe(otherRoot.nodeId)
    expect(tree.parentEdgeOf(attached.id)).toMatchObject({ origin: 'artifact', sourceArtifact: { kind: 'image', value: 'shot.png' } })
    expect(tree.parentOf(rooted.id)).toBeNull()

    // The link: browser, copy, and a Web page node (child of the conversation by default).
    await fitAll(page)
    await nodeMenu(page, 'Agent', 'Fit')
    await activate(page, 'Agent')
    const link = log.locator('button[data-artifact-kind="url"]', { hasText: 'https://example.com/page' })
    await link.click()
    popover = page.getByRole('dialog', { name: 'Link actions' })
    await expect(popover.getByRole('button')).toHaveText(['Spawn as Web page node…', 'Open in browser', 'Copy link'])
    await popover.getByRole('button', { name: 'Open in browser' }).click()
    await expect.poll(async () => (await shellCalls(app)).at(-1)).toEqual({ method: 'openExternal', target: 'https://example.com/page' })
    await link.click()
    await page.getByRole('dialog', { name: 'Link actions' }).getByRole('button', { name: 'Copy link' }).click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('https://example.com/page')
    await link.click()
    await page.getByRole('dialog', { name: 'Link actions' }).getByRole('button', { name: 'Spawn as Web page node…' }).click()
    spawn = page.getByRole('dialog', { name: 'Spawn web page from Agent' })
    await spawn.getByRole('button', { name: 'Create' }).click()
    await expect(spawn).toBeHidden()

    canvas = await readCanvas(page)
    const pageNode = canvas.nodes.find((node) => node.entityType === 'webpage')!
    expect(pageNode.config).toEqual({ url: 'https://example.com/page' })
    expect(indexTree(canvas).parentEdgeOf(pageNode.id)).toMatchObject({
      fromNodeId: nodeId,
      origin: 'artifact',
      sourceArtifact: { kind: 'url', value: 'https://example.com/page' }
    })
  } finally {
    await app.close()
  }
})

test('path chips follow the file system and leave network paths alone until the user asks', async () => {
  const session = await launchScripted()
  const { page, app, projectId } = session
  const unc = '\\\\fileserver\\share\\spec.md'
  try {
    await scriptFiles(app, {
      paths: {
        'src/App.t': { kind: 'missing' },
        'src/App.tsx': { kind: 'file' },
        'out/report.txt': { kind: 'missing' },
        'notes/todo.md': { kind: 'missing' },
        'flaky/a.txt': 'reject'
      }
    })
    const nodeId = await seedAgent(session)
    const report = (status: 'running' | 'completed'): ConversationItem =>
      items.tool('w1', { toolKind: 'edit', name: 'Write', summary: 'out/report.txt', path: 'out/report.txt', status })
    const conversationWith = (streamed: string, status: 'running' | 'completed'): ConversationItem[] => [
      items.assistant('a1', `Shared spec: \`${unc}\`. Notes: \`notes/todo.md\`. Flaky: \`flaky/a.txt\`. See [the plan](docs/plan.md).`),
      report(status),
      items.assistant('a2', streamed)
    ]
    await showAgent(session, nodeId, conversationWith('Open `src/App.t', 'running'))
    const log = conversation(page, 'Agent')
    const chip = (text: string): Locator => log.locator('button.rich-artifact').filter({ hasText: new RegExp(`^${escape(text)}$`) })
    const reportChip = log.locator('[data-tool-kind="edit"] .agent-pane__path button')

    // Visible chips are checked lazily; a network path outside the project is never touched on its own.
    await expect(chip('src/App.t')).toHaveAttribute('data-path-state', 'missing')
    await expect(reportChip).toHaveAttribute('data-path-state', 'missing')
    await expect(chip(unc)).toHaveAttribute('data-path-state', 'unchecked')
    await expect(chip(unc)).not.toHaveAttribute('aria-disabled', 'true')
    // Markdown links to paths are checked too.
    await expect(log.getByRole('button', { name: 'the plan' })).toHaveAttribute('data-path-state', 'missing')
    // A failed check is not a missing file.
    await expect(chip('flaky/a.txt')).toHaveAttribute('data-path-state', 'unknown')
    await expect(chip('flaky/a.txt')).not.toHaveAttribute('aria-disabled', 'true')

    // The streamed message completes the path: the same chip now shows the existing file.
    await setTimeline(app, nodeId, { epoch: 'e1', olderCursor: null, items: conversationWith('Open `src/App.tsx`', 'running') })
    await expect(chip('src/App.tsx')).toHaveAttribute('data-path-state', 'file')
    await expect(chip('src/App.tsx')).not.toHaveAttribute('aria-disabled', 'true')

    // The edit tool created its file: the next timeline change checks the missing path again.
    await scriptFiles(app, { paths: { 'out/report.txt': { kind: 'file' } } })
    await setTimeline(app, nodeId, { epoch: 'e1', olderCursor: null, items: conversationWith('Open `src/App.tsx`', 'completed') })
    await expect(reportChip).toHaveAttribute('data-path-state', 'file')

    // Clicking a path known to be missing checks it again.
    await scriptFiles(app, { paths: { 'notes/todo.md': { kind: 'file' }, 'flaky/a.txt': { kind: 'file' } } })
    await activate(page, 'Agent')
    await chip('notes/todo.md').click({ force: true })
    let popover = page.getByRole('dialog', { name: 'Path actions' })
    await expect(popover.getByRole('button')).toHaveText(['Reveal in Explorer', 'Copy path'])
    await page.keyboard.press('Escape')
    await chip('flaky/a.txt').click()
    await expect(popover.getByRole('button')).toHaveText(['Reveal in Explorer', 'Copy path'])
    await page.keyboard.press('Escape')

    // The network path: not checked until the user asks, from its own popover.
    await chip(unc).click()
    popover = page.getByRole('dialog', { name: 'Path actions' })
    await expect(popover).toContainText('Network path — not checked')
    await expect(popover.getByRole('button')).toHaveText(['Check this path', 'Reveal in Explorer', 'Copy path'])
    expect((await agentCalls(app, 'files.inspectPath')).filter(([, path]) => path === unc)).toEqual([])
    await scriptFiles(app, { paths: { [unc]: { kind: 'file' } } })
    await popover.getByRole('button', { name: 'Check this path' }).click()
    await expect(popover.getByRole('button')).toHaveText(['Reveal in Explorer', 'Copy path'])
    await expect(chip(unc)).toHaveAttribute('data-path-state', 'file')
    expect((await agentCalls(app, 'files.inspectPath')).filter(([, path]) => path === unc)).toEqual([[projectId, unc, { explicit: true }]])
    // Passive checks never claim to be explicit.
    for (const [, path, options] of await agentCalls(app, 'files.inspectPath')) {
      if (path !== unc) expect(options ?? {}).not.toHaveProperty('explicit', true)
    }
  } finally {
    await app.close()
  }
})

test('a network image in an answer loads only when the user asks', async () => {
  const session = await launchScripted()
  const { page, app, projectId } = session
  const pixel = `data:image/png;base64,${png(4, 4).toString('base64')}`
  const ready = { ok: true as const, image: { url: pixel, width: 4, height: 4, revision: '1' } }
  try {
    // A UNC path is recognised in the renderer; a mapped path only by the main process's answer.
    await scriptFiles(app, {
      images: { '//fileserver/share/diagram.png': { reply: ready }, 'mapped/diagram.png': { reply: ready, explicitOnly: true } }
    })
    const nodeId = await seedAgent(session)
    await showAgent(session, nodeId, [items.assistant('a1', 'UNC: ![unc diagram](//fileserver/share/diagram.png)\n\nMapped: ![mapped diagram](mapped/diagram.png)')])
    const log = conversation(page, 'Agent')
    const placeholders = log.locator('.rich-image--network')
    await expect(placeholders).toHaveCount(2)
    await expect(placeholders.first()).toContainText('Network image')
    expect((await agentCalls(app, 'files.describeImage')).filter(([, source]) => (source as { path: string }).path.startsWith('//'))).toEqual([])

    await activate(page, 'Agent')
    await placeholders.first().getByRole('button', { name: 'Load' }).click()
    await expect(log.getByRole('button', { name: 'Image: unc diagram' }).locator('img')).toHaveAttribute('src', pixel)
    await expect(placeholders).toHaveCount(1)
    await placeholders.getByRole('button', { name: 'Load' }).click()
    await expect(log.getByRole('button', { name: 'Image: mapped diagram' }).locator('img')).toHaveAttribute('src', pixel)
    const calls = await agentCalls(app, 'files.describeImage')
    expect(calls.filter(([, source]) => (source as { path: string }).path === '//fileserver/share/diagram.png')).toEqual([
      [projectId, { kind: 'path', path: '//fileserver/share/diagram.png' }, { explicit: true }]
    ])
    expect(calls.filter(([, source]) => (source as { path: string }).path === 'mapped/diagram.png').map(([, , options]) => options ?? null)).toEqual([
      null,
      { explicit: true }
    ])
  } finally {
    await app.close()
  }
})

test('a live HTML answer submits its message, data, and annotations as the next prompt; diagrams render', async () => {
  const session = await launchScripted()
  const { page, app } = session
  try {
    const nodeId = await seedAgent(session)
    const html = [
      '```spade-html Plan review',
      '<!doctype html>',
      '<button id="note" onclick="window.spade.annotate({ target: \'step-1\', text: \'Too vague\' })">Note</button>',
      '<button id="approve" onclick="window.spade.submit({ message: \'Approved\', data: { step: 2 } }).then(() => document.body.dataset.result = \'ok\', (error) => document.body.dataset.result = \'error: \' + error.message)">Approve</button>',
      '<input aria-label="Draft" onkeydown="if (event.key === \'Escape\' && this.value) { event.preventDefault(); this.value = \'\' }">',
      '```'
    ].join('\n')
    await showAgent(session, nodeId, [items.assistant('a1', `${html}\n\n\`\`\`mermaid\ngraph TD\nA-->B\n\`\`\``)])
    const log = conversation(page, 'Agent')
    await expect(log.locator('.rich-mermaid__canvas svg')).toBeVisible()

    await activate(page, 'Agent')
    const answer = page.frameLocator('iframe.rich-html__frame')
    await answer.getByRole('button', { name: 'Note' }).click()
    const pending = log.getByRole('region', { name: 'Pending annotations' })
    await expect(pending).toContainText('[step-1] Too vague')

    await answer.getByRole('button', { name: 'Approve' }).click()
    await expect(answer.locator('body')).toHaveAttribute('data-result', 'ok')
    expect(await agentCalls(app, 'agents.prompt')).toEqual([
      [
        nodeId,
        {
          text: ['[Submitted from the HTML answer “Plan review”]', 'Approved', 'Data: {"step":2}', 'Annotations:', '- [step-1] Too vague'].join('\n')
        }
      ]
    ])
    await expect(pending).toHaveCount(0)

    // A rejected prompt rejects the script's promise with the reason.
    await setReply(app, 'agents.prompt', { ok: false, error: { code: 'paseo-failed', message: 'The agent is busy' } })
    await answer.getByRole('button', { name: 'Approve' }).click()
    await expect(answer.locator('body')).toHaveAttribute('data-result', 'error: The agent is busy')

    await pushRuntime(app, runtimeFor(session.projectId, nodeId, { resourceState: 'missing' }))
    await expect(log.getByText('Submitting is unavailable: Paseo no longer has this agent.')).toBeVisible()
    await answer.getByRole('button', { name: 'Approve' }).click()
    await expect(answer.locator('body')).toHaveAttribute('data-result', 'error: Paseo no longer has this agent.')
    expect(await agentCalls(app, 'agents.prompt')).toHaveLength(2)

    // Escape inside the answer leaves the conversation (plan §6), unless the answer handled the key itself.
    await activate(page, 'Agent')
    const draft = answer.getByRole('textbox', { name: 'Draft' })
    await draft.fill('x')
    await draft.press('Escape')
    await expect(draft).toHaveValue('')
    await expect(nodeBody(page, 'Agent')).toHaveAttribute('data-active', 'true')
    await draft.press('Escape')
    await expect(nodeBody(page, 'Agent')).toHaveAttribute('data-active', 'false')
    await expect(nodeHeader(page, 'Agent')).toBeFocused()
  } finally {
    await app.close()
  }
})

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
