import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import {
  applyPrototypeCommand,
  createInitialLedger,
  type PrototypeCommand
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/commands'
import type { GitHubIssue, GitHubPullRequest } from '../../prototypes/paseo-issue-to-pr-bridge/shared/github'
import {
  reconcileGitHubIssue,
  reconcileGitHubPullRequest
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/githubReconciliation'
import type {
  P3IntegrationRequest,
  P3IntegrationResult
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/integration'
import { reconcilePaseoWorkItem } from '../../prototypes/paseo-issue-to-pr-bridge/shared/paseoReconciliation'
import type { PrototypeLedger } from '../../prototypes/paseo-issue-to-pr-bridge/shared/model'

const entry = resolve('prototypes/paseo-issue-to-pr-bridge/out/main/index.js')

type P3Window = Window & {
  spadeP3: {
    snapshot(): Promise<PrototypeLedger>
    execute(command: PrototypeCommand | Record<string, unknown>): Promise<PrototypeLedger>
    integrate(request: P3IntegrationRequest | Record<string, unknown>): Promise<P3IntegrationResult>
    subscribe(listener: (ledger: PrototypeLedger) => void): () => void
  }
}

async function launch(ledgerPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [entry],
    env: {
      ...process.env,
      SPADE_P3_LEDGER_PATH: ledgerPath,
      SPADE_P3_DISABLE_PASEO: '1'
    }
  })
}

test('runs the generic P3 shell through narrow IPC and restores the exact ledger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spade-p3-shell-'))
  const ledgerPath = join(directory, 'ledger.json')
  let application: ElectronApplication | null = null

  try {
    application = await launch(ledgerPath)
    let window = await application.firstWindow()

    await expect(window).toHaveTitle('SPADE · P3 native GitHub work shell')
    await expect(window.getByRole('heading', { name: 'P3 native GitHub work shell' })).toBeVisible()
    await expect(window.getByTestId('project-container')).toContainText('P3 bridge prototype')

    const hulls = window.locator('.group-hull')
    await expect(hulls).toHaveCount(2)
    await expect(hulls.filter({ hasText: 'Issue 17 · Generic shell' })).toHaveAttribute(
      'data-kind',
      'work-item'
    )
    await expect(hulls.filter({ hasText: 'Visual cluster' })).toHaveAttribute('data-kind', 'group')

    const activity = window.getByRole('navigation', { name: 'Work item activity' })
    await expect(activity.getByRole('button')).toHaveCount(1)
    await expect(activity).toContainText('ACTIVE')
    await expect(activity).not.toContainText('Visual cluster')

    const boundary = await window.evaluate(() => ({
      requireType: typeof (window as unknown as { require?: unknown }).require,
      processType: typeof (window as unknown as { process?: unknown }).process,
      api: Object.keys((globalThis as unknown as P3Window).spadeP3).sort()
    }))
    expect(boundary).toEqual({
      requireType: 'undefined',
      processType: 'undefined',
      api: ['execute', 'integrate', 'snapshot', 'subscribe']
    })

    const publicationCount = await window.evaluate(async () => {
      let count = 0
      const unregister = (globalThis as unknown as P3Window).spadeP3.subscribe(() => { count += 1 })
      await (globalThis as unknown as P3Window).spadeP3.execute({
        type: 'set-work-item-status',
        workItemId: 'work-item-1',
        status: 'active'
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      unregister()
      return count
    })
    expect(publicationCount).toBe(1)

    const viewport = window.locator('.react-flow__viewport')
    const transformBeforeFocus = await viewport.getAttribute('style')
    await activity.getByRole('button', { name: 'Focus Issue 17 · Generic shell' }).click()
    const workItemHull = hulls.filter({ hasText: 'Issue 17 · Generic shell' })
    await expect(workItemHull).toHaveAttribute('data-focused', 'true')
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(transformBeforeFocus)
    await expect(workItemHull).toContainText('work-item-1')

    await window.evaluate(() => (globalThis as unknown as P3Window).spadeP3.execute({
      type: 'set-work-item-status',
      workItemId: 'work-item-1',
      status: 'blocked'
    }))
    await expect(workItemHull.locator('.status--blocked')).toHaveText('BLOCKED')
    await expect(workItemHull.locator('.status--blocked')).toHaveCSS('color', 'rgb(240, 120, 120)')

    await window.getByLabel('New group name').fill('Second task')
    await window.getByLabel('Work item task').fill('Exercise generic creation')
    await window.getByRole('button', { name: 'Create WorkItem' }).click()
    await expect(activity.getByRole('button')).toHaveCount(2)

    await window.getByLabel('Target group').fill('Issue 17 · Generic shell')
    await window.getByLabel('Placeholder title').fill('Added agent')
    await window.getByLabel('External placeholder ID').fill('agent-added')
    await window.getByRole('button', { name: 'Spawn agent' }).click()

    await window.getByLabel('Placeholder title').fill('Added workspace')
    await window.getByLabel('External placeholder ID').fill('workspace-added')
    await window.getByRole('button', { name: 'Attach workspace' }).click()
    await expect(window.locator('.generic-node')).toHaveCount(4)

    await window.getByLabel('From node', { exact: true }).selectOption({ label: 'Added agent' })
    await window.getByLabel('To node', { exact: true }).selectOption({ label: 'Added workspace' })
    await window.getByRole('button', { name: 'Connect nodes' }).click()
    await expect(window.locator('.react-flow__edge')).toHaveCount(2)

    await window.getByLabel('New group name').fill('Duplicate')
    await window.getByRole('button', { name: 'Create Group' }).click()
    await window.getByRole('button', { name: 'Create Group' }).click()
    await window.getByLabel('Target group').fill('Duplicate')
    await window.getByLabel('Placeholder title').fill('Ambiguous agent')
    await window.getByLabel('External placeholder ID').fill('ambiguous-agent')
    await window.getByRole('button', { name: 'Spawn agent' }).click()
    await expect(window.getByRole('alert')).toContainText(
      'More than one group is named “Duplicate”. Use a stable group ID.'
    )

    const ambiguousLedger = await window.evaluate(() =>
      (globalThis as unknown as P3Window).spadeP3.snapshot()
    )
    const duplicateId = ambiguousLedger.groups.find(({ name }) => name === 'Duplicate')!.id
    await window.getByLabel('Target group').fill(duplicateId)
    await window.getByRole('button', { name: 'Spawn agent' }).click()
    await expect(window.getByRole('alert')).toHaveCount(0)
    await expect(window.locator('.generic-node')).toHaveCount(5)

    const beforeReload = await window.evaluate(() => (globalThis as unknown as P3Window).spadeP3.snapshot())
    expect(beforeReload.groups).toHaveLength(5)
    expect(beforeReload.nodes).toHaveLength(5)
    expect(beforeReload.edges).toHaveLength(2)
    expect(beforeReload.nodes.find(({ title }) => title === 'Added agent')?.resourceRef).toEqual({
      provider: 'placeholder',
      kind: 'agent',
      id: 'agent-added',
      revision: null
    })
    await window.screenshot({ path: test.info().outputPath('p3-generic-shell.png') })

    await application.close()
    application = await launch(ledgerPath)
    window = await application.firstWindow()

    await expect(window.locator('.group-hull')).toHaveCount(5)
    await expect(window.locator('.generic-node')).toHaveCount(5)
    await expect(window.locator('.react-flow__edge')).toHaveCount(2)
    await expect(window.getByRole('navigation', { name: 'Work item activity' }).getByRole('button')).toHaveCount(2)

    const afterReload = await window.evaluate(() => (globalThis as unknown as P3Window).spadeP3.snapshot())
    expect(afterReload).toEqual(beforeReload)
    expect(JSON.parse(await readFile(ledgerPath, 'utf8'))).toEqual(beforeReload)
  } finally {
    if (application) await application.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('renders live Paseo resource states and bounded conversation expansion defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spade-p3-live-shell-'))
  const ledgerPath = join(directory, 'ledger.json')
  let ledger = createInitialLedger('project-1', 'Prototype project')
  ledger = applyPrototypeCommand(ledger, {
    type: 'create-work-item',
    name: 'Live bridge',
    task: 'Render live Paseo facts'
  }).ledger
  ledger = reconcilePaseoWorkItem(ledger, 'work-item-1', {
    rootAgentId: 'root-agent',
    agentPages: [[{
      id: 'root-agent',
      parentAgentId: null,
      workspaceId: 'workspace-root',
      title: 'Root agent',
      provider: 'pi',
      model: 'model-1',
      status: 'running',
      cwd: '/opaque/root',
      updatedAt: '2026-08-21T10:00:00Z'
    }]],
    workspacePages: [[{
      id: 'workspace-root',
      projectId: 'project-1',
      name: 'Opaque workspace',
      directory: '/opaque/workspace',
      branch: 'opaque-branch',
      status: 'active',
      updatedAt: '2026-08-21T10:00:00Z'
    }]],
    providerSubagents: [{
      id: 'native-child',
      parentAgentId: 'root-agent',
      provider: 'pi-native',
      title: 'Provider child',
      status: 'running',
      cwd: null,
      updatedAt: '2026-08-21T10:00:01Z',
      timeline: []
    }],
    timelines: [{
      agentId: 'root-agent',
      epoch: 'epoch-1',
      entries: [
        {
          timestamp: '2026-08-21T10:00:01Z',
          seqStart: 1,
          item: { type: 'tool_call', name: 'write', detail: { type: 'diff' } }
        },
        {
          timestamp: '2026-08-21T10:00:02Z',
          seqStart: 2,
          item: { type: 'tool_call', name: 'read', detail: { type: 'read' } }
        }
      ]
    }],
    refreshedAt: '2026-08-21T10:00:03Z'
  })
  ledger = {
    ...ledger,
    paseo: {
      ...ledger.paseo,
      daemonUrl: 'ws://127.0.0.1:7777/ws',
      bindings: [{ workItemId: 'work-item-1', rootAgentId: 'root-agent' }]
    }
  }
  await writeFile(ledgerPath, JSON.stringify(ledger), 'utf8')
  const application = await launch(ledgerPath)

  try {
    const window = await application.firstWindow()
    await expect(window.getByTestId('paseo-connection')).toContainText('CONNECTED')
    await expect(window.getByTestId('paseo-capabilities')).toContainText(
      'provider-subagents · UNAVAILABLE'
    )

    const managed = window.locator('[data-paseo-type="managed-agent"]')
    await expect(managed).toContainText('MANAGED AGENT')
    await expect(managed).toContainText('pi · model-1')
    await expect(managed).toContainText('workspace-root')
    const providerNative = window.locator('[data-paseo-type="provider-subagent"]')
    await expect(providerNative).toContainText('PROVIDER SUBAGENT')
    await expect(providerNative).toContainText('pi-native')
    const workspace = window.locator('[data-paseo-type="workspace"]')
    await expect(workspace).toContainText('/opaque/workspace')
    await expect(workspace).toContainText('opaque-branch')

    const events = managed.locator('.conversation-event')
    await expect(events).toHaveCount(2)
    await expect(events.filter({ hasText: 'write' })).toHaveAttribute('open', '')
    const readEvent = events.filter({ hasText: 'read' })
    await expect(readEvent).not.toHaveAttribute('open', '')
    await readEvent.locator('summary').click()
    await expect(readEvent).toHaveAttribute('open', '')
    await window.evaluate(() => (globalThis as unknown as P3Window).spadeP3.execute({
      type: 'set-work-item-status',
      workItemId: 'work-item-1',
      status: 'blocked'
    }))
    await expect(readEvent).toHaveAttribute('open', '')
    await expect(window.getByRole('heading', { name: 'Paseo bridge' })).toBeVisible()
    await window.screenshot({ path: test.info().outputPath('p3-paseo-live.png') })
  } finally {
    await application.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('renders persisted native GitHub Issue and PullRequest nodes with shared chrome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spade-p3-github-shell-'))
  const ledgerPath = join(directory, 'ledger.json')
  const issue: GitHubIssue = {
    repository: 'skflowne/spade-fixture',
    number: 1,
    title: 'Scaffold a Vue app',
    state: 'OPEN',
    labels: ['prototype'],
    body: 'Build the fixture.',
    url: 'https://github.com/skflowne/spade-fixture/issues/1',
    updatedAt: '2026-08-20T12:03:05Z'
  }
  const pullRequest: GitHubPullRequest = {
    repository: 'skflowne/spade-fixture',
    number: 7,
    title: 'Build fixture',
    state: 'OPEN',
    author: 'octocat',
    url: 'https://github.com/skflowne/spade-fixture/pull/7',
    baseBranch: 'main',
    headBranch: 'spade-fixture',
    latestRevision: 'abcdef123456',
    updatedAt: '2026-08-20T13:00:00Z',
    checks: [{ name: 'build', state: 'passed', url: null }],
    reviews: [{ author: 'reviewer', state: 'APPROVED', body: '', submittedAt: '2026-08-20T12:50:00Z' }],
    comments: [{ author: 'maintainer', body: 'Ready.', createdAt: '2026-08-20T12:51:00Z' }],
    reviewComments: [{ author: 'reviewer', body: 'Nice.', path: 'src/App.vue', createdAt: '2026-08-20T12:52:00Z' }]
  }
  let ledger = reconcileGitHubIssue(createInitialLedger('project-p3', 'Fixture project'), issue).ledger
  ledger = applyPrototypeCommand(ledger, {
    type: 'attach-placeholder',
    targetGroup: 'work-item-1',
    nodeKind: 'workspace',
    title: 'Fixture checkout',
    resourceRef: { provider: 'paseo', kind: 'workspace', id: 'workspace-opaque-1', revision: null }
  }).ledger
  ledger = reconcileGitHubPullRequest(ledger, pullRequest, 'node-3').ledger
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')

  const application = await launch(ledgerPath)
  try {
    const window = await application.firstWindow()
    await expect(window.locator('.github-node')).toHaveCount(2)
    const issueNode = window.locator('.github-node').filter({ hasText: issue.title })
    await expect(issueNode).toContainText('skflowne/spade-fixture#1')
    await expect(issueNode).toContainText('prototype')
    await expect(issueNode.getByRole('button', { name: 'Open on GitHub' })).toBeVisible()

    const pullRequestNode = window.locator('.github-node').filter({ hasText: pullRequest.title })
    await expect(pullRequestNode).toContainText('main ← spade-fixture')
    await expect(pullRequestNode).toContainText('1 passed · 0 failed · 0 pending · 0 skipped')
    await expect(pullRequestNode).toContainText('1 reviews · 1 comments · 1 inline')
    const pullRequestActivity = pullRequestNode.locator('.github-activity')
    await expect(pullRequestActivity).toContainText('INLINE')
    await expect(pullRequestActivity).toContainText('src/App.vue: Nice.')
    await expect(pullRequestNode.getByRole('button', { name: 'Refresh PR' })).toBeVisible()
    await expect(window.getByLabel('Repository')).toHaveValue('skflowne/spade-fixture')
    await expect(window.getByRole('button', { name: 'Refresh checkout' })).toBeVisible()
    await expect(window.getByRole('button', { name: 'Create/link PR' })).toBeVisible()
  } finally {
    await application.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects malformed renderer commands at runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spade-p3-ipc-'))
  const ledgerPath = join(directory, 'ledger.json')
  const application = await launch(ledgerPath)

  try {
    const window = await application.firstWindow()
    const messages = await window.evaluate(async () => {
      const commands = [
        { type: 'create-group', name: 'Invalid', unexpected: true },
        { type: 'create-work-item', name: 'Invalid', task: 'Invalid', status: ['active'] },
        {
          type: 'connect-nodes',
          fromNodeId: 'node-3',
          toNodeId: 'node-4',
          relation: ['connected']
        },
        {
          type: 'spawn-agent',
          targetGroup: 'work-item-1',
          cwd: '/opaque/root',
          provider: ['pi'],
          model: 'model-1',
          prompt: 'Caller prompt'
        },
        {
          type: 'attach-agent',
          targetGroup: 'work-item-1',
          agentId: 'root',
          unexpected: true
        }
      ]
      return Promise.all(commands.map(async (command) => {
        try {
          await (globalThis as unknown as P3Window).spadeP3.execute(command)
          return 'accepted'
        } catch (error) {
          return String(error)
        }
      }))
    })
    expect(messages).toHaveLength(5)
    for (const message of messages) expect(message).toContain('Invalid P3 prototype command')
    const integrationResults = await window.evaluate(() => Promise.all([
      (globalThis as unknown as P3Window).spadeP3.integrate({
        type: 'checkout-status',
        workspaceNodeId: 'node-4',
        cwd: '/tmp/injected'
      }),
      (globalThis as unknown as P3Window).spadeP3.integrate({
        type: 'github-issue-detail',
        repository: 'skflowne/spade-fixture',
        number: 0
      })
    ]))
    expect(integrationResults).toEqual([
      { ok: false, error: { kind: 'invalid-request', message: 'Invalid P3 integration request.' } },
      { ok: false, error: { kind: 'invalid-request', message: 'Invalid P3 integration request.' } }
    ])

    const snapshot = await window.evaluate(() => (globalThis as unknown as P3Window).spadeP3.snapshot())
    expect(snapshot.groups).toHaveLength(2)
    expect(snapshot.edges).toHaveLength(1)
  } finally {
    await application.close()
    await rm(directory, { recursive: true, force: true })
  }
})
