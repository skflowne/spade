import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import type { PrototypeCommand } from '../../prototypes/paseo-issue-to-pr-bridge/shared/commands'
import type { PrototypeLedger } from '../../prototypes/paseo-issue-to-pr-bridge/shared/model'

const entry = resolve('prototypes/paseo-issue-to-pr-bridge/out/main/index.js')

type P3Window = Window & {
  spadeP3: {
    snapshot(): Promise<PrototypeLedger>
    execute(command: PrototypeCommand | Record<string, unknown>): Promise<PrototypeLedger>
    subscribe(listener: (ledger: PrototypeLedger) => void): () => void
  }
}

async function launch(ledgerPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [entry],
    env: { ...process.env, SPADE_P3_LEDGER_PATH: ledgerPath }
  })
}

test('runs the generic P3 shell through narrow IPC and restores the exact ledger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spade-p3-shell-'))
  const ledgerPath = join(directory, 'ledger.json')
  let application: ElectronApplication | null = null

  try {
    application = await launch(ledgerPath)
    let window = await application.firstWindow()

    await expect(window).toHaveTitle('SPADE · P3 generic work shell')
    await expect(window.getByRole('heading', { name: 'P3 generic work shell' })).toBeVisible()
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
      api: ['execute', 'snapshot', 'subscribe']
    })

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
    expect(messages).toHaveLength(3)
    for (const message of messages) expect(message).toContain('Invalid P3 prototype command')
    const snapshot = await window.evaluate(() => (globalThis as unknown as P3Window).spadeP3.snapshot())
    expect(snapshot.groups).toHaveLength(2)
    expect(snapshot.edges).toHaveLength(1)
  } finally {
    await application.close()
    await rm(directory, { recursive: true, force: true })
  }
})
