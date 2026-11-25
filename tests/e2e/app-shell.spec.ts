import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { WorkspaceError } from '../../src/main/gateway'
import { INTERNAL_FAILURE_MESSAGE, toCommandFailure, toFailure } from '../../src/main/ipc/failures'
import { CanvasCommandError } from '../../src/shared/commands'
import type { SpadeHostBridge } from '../../src/shared/ipc'

type HostWindow = Window & { spadeHost: SpadeHostBridge }

let scratch: string

test.beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'spade-shell-'))
})

test.afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function scratchDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(join(scratch, `${name}-`))
  return directory
}

async function launch(userDataDirectory: string): Promise<{ app: ElectronApplication; page: Page }> {
  // The shell's behavior never depends on a Paseo daemon, and tests must not reach a live one.
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${userDataDirectory}`],
    env: { ...process.env, SPADE_DISABLE_PASEO: '1' }
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => 'spadeHost' in window)
  return { app, page }
}

// Replaces the native folder picker in the main process; the next pick returns `directory`, or cancels on null.
async function pickNext(app: ElectronApplication, directory: string | null): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () =>
      path === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [path] }) as typeof dialog.showOpenDialog
  }, directory)
}

async function openProject(app: ElectronApplication, page: Page, directory: string): Promise<string> {
  await pickNext(app, directory)
  const response = await page.evaluate(() => (window as unknown as HostWindow).spadeHost.projects.open())
  if (!response.ok || !('project' in response)) throw new Error(`Opening ${directory} failed: ${JSON.stringify(response)}`)
  return response.project.id
}

async function addNote(page: Page, projectId: string, title: string): Promise<void> {
  const response = await page.evaluate(
    ([id, noteTitle]) =>
      (window as unknown as HostWindow).spadeHost.canvas.execute(id, {
        type: 'startTree',
        node: { entityType: 'note', config: { body: noteTitle }, title: noteTitle }
      }),
    [projectId, title] as const
  )
  expect(response).toMatchObject({ ok: true, created: true })
}

async function listEntries(directory: string): Promise<string[]> {
  return readdir(directory, { recursive: true })
}

test('keeps two project canvases and the selection across a relaunch without writing into the projects', async () => {
  const userData = await scratchDirectory('user-data')
  const alphaRoot = await scratchDirectory('alpha')
  const betaRoot = await scratchDirectory('beta')

  const first = await launch(userData)
  let before: unknown
  let alphaId: string
  try {
    alphaId = await openProject(first.app, first.page, alphaRoot)
    const betaId = await openProject(first.app, first.page, betaRoot)
    await addNote(first.page, alphaId, 'Alpha plan')
    await addNote(first.page, betaId, 'Beta sketch')
    await addNote(first.page, betaId, 'Beta follow-up')

    await pickNext(first.app, null)
    expect(await first.page.evaluate(() => (window as unknown as HostWindow).spadeHost.projects.open())).toEqual({
      ok: true,
      cancelled: true
    })
    expect(
      await first.page.evaluate((id) => (window as unknown as HostWindow).spadeHost.projects.select(id), alphaId)
    ).toEqual({ ok: true })

    before = await first.page.evaluate(async (ids) => {
      const host = (window as unknown as HostWindow).spadeHost
      const state = await host.app.getState()
      return {
        projects: state.projects,
        selectedProjectId: state.selectedProjectId,
        canvases: await Promise.all(ids.map((id) => host.canvas.get(id)))
      }
    }, [alphaId, betaId])
  } finally {
    await first.app.close()
  }

  const second = await launch(userData)
  try {
    const after = await second.page.evaluate(async (ids) => {
      const host = (window as unknown as HostWindow).spadeHost
      const state = await host.app.getState()
      return {
        projects: state.projects,
        selectedProjectId: state.selectedProjectId,
        canvases: await Promise.all(ids.map((id) => host.canvas.get(id)))
      }
    }, (before as { projects: Array<{ id: string }> }).projects.map((project) => project.id))

    expect(after).toEqual(before)
    expect(after.selectedProjectId).toBe(alphaId)
    expect(after.canvases.map((canvas) => canvas.nodes.map((node) => node.title))).toEqual([
      ['Alpha plan'],
      ['Beta sketch', 'Beta follow-up']
    ])
  } finally {
    await second.app.close()
  }

  expect(await listEntries(alphaRoot)).toEqual([])
  expect(await listEntries(betaRoot)).toEqual([])
  expect(await listEntries(join(userData, 'data'))).toContain('index.json')
})

test('adds only the typed host bridge to the renderer global scope', async () => {
  const { app, page } = await launch(await scratchDirectory('user-data'))
  try {
    const globals = await page.evaluate(() => {
      const frame = document.createElement('iframe')
      document.body.append(frame)
      const pristine = new Set(Object.getOwnPropertyNames(frame.contentWindow))
      frame.remove()
      const host = (window as unknown as HostWindow).spadeHost
      return {
        added: Object.getOwnPropertyNames(window).filter((name) => !pristine.has(name)),
        nodeGlobals: ['require', 'process', 'module', 'Buffer', 'global'].filter((name) => name in window),
        bridge: Object.fromEntries(Object.entries(host).map(([name, value]) => [name, Object.keys(value).sort()]))
      }
    })

    // `WebView` is Electron's <webview> element class, defined because the window enables webviewTag.
    expect(globals.added.sort()).toEqual(['WebView', 'spadeHost'])
    expect(globals.nodeGlobals).toEqual([])
    expect(globals.bridge).toEqual({
      app: ['getState', 'onState', 'updateSettings'],
      projects: ['changeRoot', 'open', 'remove', 'rename', 'select'],
      canvas: ['execute', 'get', 'onChanged'],
      agents: [
        'expandChild',
        'getRuntimes',
        'getTimeline',
        'interrupt',
        'listProviders',
        'onRuntime',
        'onTimelineChanged',
        'openProviderSubagent',
        'prompt',
        'refreshConnection',
        'respondToAgentPermission',
        'respondToPermission',
        'setMode'
      ],
      files: [
        'copyText',
        'describeImage',
        'importImage',
        'inspectPath',
        'onImageChanged',
        'openExternal',
        'pickImage',
        'reveal'
      ]
    })
  } finally {
    await app.close()
  }
})

test('answers invalid bridge calls with failures instead of exceptions', async () => {
  const { app, page } = await launch(await scratchDirectory('user-data'))
  try {
    const answers = await page.evaluate(async () => {
      const host = (window as unknown as HostWindow).spadeHost as unknown as {
        projects: { select(id: unknown): Promise<unknown>; rename(id: unknown, name: unknown): Promise<unknown> }
        canvas: { execute(id: unknown, command: unknown): Promise<unknown>; get(id: unknown): Promise<unknown> }
        agents: { prompt(id: unknown, input: unknown): Promise<unknown> }
        app: { updateSettings(patch: unknown): Promise<unknown> }
      }
      return {
        select: await host.projects.select(42),
        rename: await host.projects.rename('no-such-project', 'Name'),
        command: await host.canvas.execute('no-such-project', { type: 'detonate' }),
        unknownProject: await host.canvas.execute('no-such-project', {
          type: 'startTree',
          node: { entityType: 'note', config: { body: '' } }
        }),
        settings: await host.app.updateSettings({ paseoUrl: 7 }),
        prompt: await host.agents.prompt('node', { text: 'hi', extra: true }),
        unknownAgent: await host.agents.prompt('node', { text: 'hi' }),
        get: await host.canvas.get(null).then(
          () => 'resolved',
          (error: Error) => error.message
        )
      }
    })

    expect(answers.select).toMatchObject({ ok: false, error: { code: 'invalid-argument' } })
    expect(answers.rename).toMatchObject({ ok: false, error: { code: 'unknown-project' } })
    expect(answers.command).toMatchObject({ ok: false, error: { code: 'invalid-command' } })
    expect(answers.unknownProject).toMatchObject({ ok: false, error: { code: 'unknown-project' } })
    expect(answers.settings).toMatchObject({ ok: false, error: { code: 'invalid-argument' } })
    expect(answers.prompt).toMatchObject({ ok: false, error: { code: 'invalid-argument' } })
    expect(answers.unknownAgent).toMatchObject({ ok: false, error: { code: 'unknown-node' } })
    expect(answers.get).toMatch(/^invalid-argument: /)
    expect(JSON.stringify(answers)).not.toMatch(/\n\s+at /)
  } finally {
    await app.close()
  }
})

test('path access options cross the bridge: a network path is touched only on an explicit request', async () => {
  const { app, page } = await launch(await scratchDirectory('user-data'))
  try {
    await pickNext(app, await scratchDirectory('project'))
    const answers = await page.evaluate(async () => {
      const host = (window as unknown as HostWindow).spadeHost
      const opened = await host.projects.open()
      if (!opened.ok || !('project' in opened)) throw new Error('no project')
      const id = opened.project.id
      // `.invalid` never resolves, should a real lookup ever happen.
      const path = '\\\\spade-test.invalid\\share\\shot.png'
      const loose = host.files as unknown as {
        inspectPath(id: string, path: string, options: unknown): Promise<unknown>
        describeImage(id: string, source: unknown, options: unknown): Promise<unknown>
      }
      return {
        quiet: await host.files.inspectPath(id, path),
        image: await host.files.describeImage(id, { kind: 'path', path }),
        badInspect: await loose.inspectPath(id, path, { explicit: 'yes' }).then(
          () => 'resolved',
          (error: Error) => error.message
        ),
        badDescribe: await loose.describeImage(id, { kind: 'path', path }, { explicit: true, extra: 1 }),
        explicit: await host.files.inspectPath(id, path, { explicit: true }),
        afterwards: await host.files.inspectPath(id, path)
      }
    })
    expect(answers.quiet).toMatchObject({ kind: 'unchecked' })
    expect(answers.image).toMatchObject({ ok: false, error: { code: 'network-path' } })
    expect(answers.badInspect).toMatch(/^invalid-argument: /)
    expect(answers.badDescribe).toMatchObject({ ok: false, error: { code: 'invalid-argument' } })
    expect(answers.explicit).toMatchObject({ kind: 'missing' })
    expect(answers.afterwards).toMatchObject({ kind: 'missing' })
  } finally {
    await app.close()
  }
})

test('reports unexpected host errors as internal failures without their details', () => {
  const unexpected = Object.assign(new Error('EACCES: permission denied, open C:\\secret'), { code: 'EACCES' })
  const quiet = console.error
  console.error = () => {}
  try {
    expect(toFailure(unexpected)).toEqual({ ok: false, error: { code: 'internal', message: INTERNAL_FAILURE_MESSAGE } })
    expect(toFailure('thrown string')).toEqual({ ok: false, error: { code: 'internal', message: INTERNAL_FAILURE_MESSAGE } })
    expect(toCommandFailure(new WorkspaceError('unknown-project', 'Unknown project: x'))).toMatchObject({
      error: { code: 'internal' }
    })
  } finally {
    console.error = quiet
  }
  expect(toFailure(new WorkspaceError('root-in-use', 'Taken'))).toEqual({
    ok: false,
    error: { code: 'root-in-use', message: 'Taken' }
  })
  expect(toCommandFailure(new CanvasCommandError('cycle', 'Would cycle'))).toEqual({
    ok: false,
    error: { code: 'cycle', message: 'Would cycle' }
  })
})

test('pushes applied canvas commands and project changes to the renderer', async () => {
  const { app, page } = await launch(await scratchDirectory('user-data'))
  try {
    await page.evaluate(() => {
      const host = (window as unknown as HostWindow).spadeHost
      const received = { canvases: [] as unknown[], states: [] as unknown[] }
      ;(window as unknown as { received: typeof received }).received = received
      host.canvas.onChanged((canvas) => received.canvases.push(canvas))
      host.app.onState((state) => received.states.push(state))
    })
    const projectId = await openProject(app, page, await scratchDirectory('project'))
    await addNote(page, projectId, 'Pushed')

    const read = () =>
      page.evaluate(() => (window as unknown as { received: { canvases: unknown[]; states: unknown[] } }).received)
    await expect.poll(async () => (await read()).canvases.length).toBe(1)
    const received = await read()
    expect(received.canvases).toEqual([
      expect.objectContaining({ projectId, nodes: [expect.objectContaining({ title: 'Pushed' })] })
    ])
    expect(received.states.at(-1)).toMatchObject({
      selectedProjectId: projectId,
      projects: [expect.objectContaining({ id: projectId })],
      paseo: { state: 'disabled' },
      problems: []
    })
  } finally {
    await app.close()
  }
})
