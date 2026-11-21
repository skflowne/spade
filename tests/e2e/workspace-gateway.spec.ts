import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { EntityCreateInput, EntityCreateResult, MainEntityAdapter, WorkspaceGatewayEvent } from '../../src/main/contracts'
import { SpadeWorkspaceGateway, WorkspaceError } from '../../src/main/gateway'
import { AppDataStore, nodeFileOperations, type PersistenceFileOperations } from '../../src/main/persistence'
import { WEB_PAGE_ENTITY, createBuiltinEntityRegistry } from '../../src/shared/builtinEntities'
import { CanvasCommandError, type CanvasCommand, type NodeSeed } from '../../src/shared/commands'
import type { Actor } from '../../src/shared/domain'

const user: Actor = { kind: 'user' }
const agent: Actor = { kind: 'agent', nodeId: 'agent-node', agentId: 'paseo-agent-1' }

type Fixture = {
  dataDirectory: string
  projectDirectory(name: string): Promise<string>
  open(options?: { files?: PersistenceFileOperations }): Promise<SpadeWorkspaceGateway>
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'spade-gateway-'))
  const dataDirectory = join(root, 'data')
  let ids = 0
  try {
    await run({
      dataDirectory,
      async projectDirectory(name) {
        const directory = join(root, name)
        await mkdir(directory)
        return directory
      },
      open: (options = {}) =>
        SpadeWorkspaceGateway.open({
          store: new AppDataStore({ directory: dataDirectory, files: options.files }),
          entities: createBuiltinEntityRegistry(),
          now: () => new Date('2026-11-21T10:00:00.000Z'),
          createId: () => `id-${(ids += 1)}`
        })
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function note(title: string, extra: Partial<NodeSeed> = {}): NodeSeed {
  return { entityType: 'note', config: { body: title }, title, ...extra }
}

async function expectCode(action: Promise<unknown>, code: string): Promise<void> {
  const error = await action.then(
    () => null,
    (reason: unknown) => reason
  )
  expect(error, `expected a rejection with ${code}`).not.toBeNull()
  expect((error as { code?: unknown }).code).toBe(code)
}

function deferred<Value>(): { promise: Promise<Value>; resolve(value: Value): void } {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((done) => (resolve = done))
  return { promise, resolve }
}

function recordingAdapter(
  type: string,
  create: (input: EntityCreateInput) => Promise<EntityCreateResult>
): MainEntityAdapter & { calls: EntityCreateInput[] } {
  const calls: EntityCreateInput[] = []
  return {
    type,
    calls,
    create(input) {
      calls.push(input)
      return create(input)
    }
  }
}

test('opens, renames, re-roots, selects and removes projects without touching their directories', async () => {
  await withFixture(async ({ dataDirectory, projectDirectory, open }) => {
    const alphaRoot = await projectDirectory('alpha')
    const betaRoot = await projectDirectory('beta')
    const gammaRoot = await projectDirectory('gamma')
    const gateway = await open()

    const alpha = await gateway.createProject(alphaRoot)
    expect(alpha.created).toBe(true)
    expect(alpha.project).toMatchObject({ name: 'alpha', rootPath: alphaRoot })
    expect(gateway.selectedProjectId()).toBe(alpha.project.id)

    const again = await gateway.createProject(`${alphaRoot.toUpperCase()}/`)
    expect(again).toEqual({ project: alpha.project, created: false })

    const beta = await gateway.createProject(betaRoot)
    expect(gateway.selectedProjectId()).toBe(beta.project.id)
    expect(gateway.listProjects().map((project) => project.name)).toEqual(['alpha', 'beta'])

    await gateway.selectProject(alpha.project.id)
    expect(gateway.selectedProjectId()).toBe(alpha.project.id)
    await expectCode(gateway.selectProject('missing'), 'unknown-project')

    await gateway.renameProject(alpha.project.id, 'Alpha framework')
    expect(gateway.getProject(alpha.project.id)?.name).toBe('Alpha framework')
    await expectCode(gateway.renameProject(alpha.project.id, '   '), 'invalid-argument')

    await expectCode(gateway.changeProjectRoot(alpha.project.id, betaRoot), 'root-in-use')
    await gateway.changeProjectRoot(alpha.project.id, gammaRoot)
    expect(gateway.getProject(alpha.project.id)).toMatchObject({ id: alpha.project.id, rootPath: gammaRoot })

    await gateway.execute(beta.project.id, { type: 'startTree', node: note('beta note') }, user)
    expect(await readdir(join(dataDirectory, 'canvases'))).toContain(`${beta.project.id}.json`)

    await gateway.selectProject(beta.project.id)
    await gateway.removeProject(beta.project.id)
    expect(gateway.listProjects().map((project) => project.id)).toEqual([alpha.project.id])
    expect(gateway.selectedProjectId()).toBe(alpha.project.id)
    expect(await readdir(join(dataDirectory, 'canvases'))).not.toContain(`${beta.project.id}.json`)

    await gateway.removeProject(alpha.project.id)
    expect(gateway.selectedProjectId()).toBeNull()

    for (const root of [alphaRoot, betaRoot, gammaRoot]) {
      expect((await stat(root)).isDirectory()).toBe(true)
      expect(await readdir(root)).toEqual([])
    }
  })
})

test('applies commands from concurrent callers one at a time in arrival order', async () => {
  // Slow, jittered writes widen the window in which unserialized commands would overwrite each other.
  const slowFiles: PersistenceFileOperations = {
    ...nodeFileOperations,
    writeNewFile: async (path, data) => {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 8))
      await nodeFileOperations.writeNewFile(path, data)
    }
  }
  await withFixture(async ({ projectDirectory, open }) => {
    const gateway = await open({ files: slowFiles })
    const { project } = await gateway.createProject(await projectDirectory('busy'))
    const titles = Array.from({ length: 20 }, (_, index) => `note ${index}`)

    const outcomes = await Promise.all(
      titles.map((title, index) =>
        gateway.execute(project.id, { type: 'startTree', node: note(title) }, index % 2 === 0 ? user : agent)
      )
    )

    const canvas = await gateway.getCanvas(project.id)
    expect(canvas.nodes.map((node) => node.title)).toEqual(titles)
    expect(canvas.nodes.map((node) => node.id)).toEqual(outcomes.map((outcome) => outcome.nodeId))
    expect(canvas.activity.map((entry) => entry.nodeIds[0])).toEqual(outcomes.map((outcome) => outcome.nodeId))

    const reopened = await open()
    expect(await reopened.getCanvas(project.id)).toEqual(canvas)
  })
})

test('creates the resource through the entity adapter before the node and merges the result', async () => {
  await withFixture(async ({ projectDirectory, open }) => {
    const gateway = await open()
    const { project } = await gateway.createProject(await projectDirectory('viewer'))
    const adapter = recordingAdapter(WEB_PAGE_ENTITY, async (input) => ({
      resourceRef: { provider: 'electron', kind: 'webview', id: `page-for-${input.nodeId}` },
      title: 'Adapter title',
      shortDescription: 'Adapter description',
      size: { width: 800, height: 500 },
      config: { url: 'https://example.com/normalized' }
    }))
    gateway.registerEntityAdapter(adapter)

    const root = await gateway.execute(project.id, { type: 'startTree', node: note('root') }, user)
    const outcome = await gateway.execute(
      project.id,
      {
        type: 'spawnChild',
        sourceNodeId: root.nodeId!,
        node: {
          entityType: WEB_PAGE_ENTITY,
          config: { url: 'https://example.com' },
          shortDescription: 'Kept from the seed'
        },
        origin: 'spawned'
      },
      agent
    )

    expect(adapter.calls).toHaveLength(1)
    const [call] = adapter.calls
    expect(call.nodeId).toBe(outcome.nodeId)
    expect(call.project).toEqual(project)
    expect(call.sourceNode?.id).toBe(root.nodeId)
    expect(call.actor).toEqual(agent)
    expect(call.config).toEqual({ url: 'https://example.com' })

    const created = (await gateway.getCanvas(project.id)).nodes.find((node) => node.id === outcome.nodeId)
    expect(created).toMatchObject({
      resourceRef: { provider: 'electron', kind: 'webview', id: `page-for-${outcome.nodeId}` },
      title: 'Adapter title',
      shortDescription: 'Kept from the seed',
      size: { width: 800, height: 500 },
      config: { url: 'https://example.com/normalized' }
    })

    // A seed that already names its resource is not created again.
    await gateway.execute(
      project.id,
      {
        type: 'startTree',
        node: {
          entityType: WEB_PAGE_ENTITY,
          config: { url: 'https://example.com/existing' },
          resourceRef: { provider: 'electron', kind: 'webview', id: 'existing' }
        }
      },
      user
    )
    expect(adapter.calls).toHaveLength(1)
  })
})

test('keeps applying other commands while an entity adapter is still creating its resource', async () => {
  await withFixture(async ({ projectDirectory, open }) => {
    const gateway = await open()
    const { project } = await gateway.createProject(await projectDirectory('slow-spawn'))
    const release = deferred<EntityCreateResult>()
    const started = deferred<void>()
    gateway.registerEntityAdapter(
      recordingAdapter(WEB_PAGE_ENTITY, () => {
        started.resolve()
        return release.promise
      })
    )
    const { nodeId } = await gateway.execute(project.id, { type: 'startTree', node: note('movable') }, user)

    const spawn = gateway.execute(
      project.id,
      { type: 'startTree', node: { entityType: WEB_PAGE_ENTITY, config: { url: 'https://example.com' } } },
      user
    )
    await started.promise
    await gateway.execute(project.id, { type: 'moveNodes', moves: [{ nodeId: nodeId!, position: { x: 900, y: 40 } }] }, user)
    expect((await gateway.getCanvas(project.id)).nodes).toHaveLength(1)

    release.resolve({ resourceRef: { provider: 'electron', kind: 'webview', id: 'late' } })
    await spawn
    expect((await gateway.getCanvas(project.id)).nodes.map((node) => node.position)).toContainEqual({ x: 900, y: 40 })
    expect((await gateway.getCanvas(project.id)).nodes).toHaveLength(2)
  })
})

test('fails a creation with entity-create-failed and persists nothing when the adapter fails', async () => {
  await withFixture(async ({ projectDirectory, open }) => {
    const gateway = await open()
    const { project } = await gateway.createProject(await projectDirectory('failing'))
    const adapter = recordingAdapter(WEB_PAGE_ENTITY, async () => {
      throw new Error('Paseo is unreachable')
    })
    gateway.registerEntityAdapter(adapter)
    const before = await gateway.getCanvas(project.id)
    const events: WorkspaceGatewayEvent[] = []
    gateway.subscribe((event) => events.push(event))

    const failure = await gateway
      .execute(project.id, { type: 'startTree', node: { entityType: WEB_PAGE_ENTITY, config: { url: 'https://example.com' } } }, user)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CanvasCommandError)
    expect(failure).toMatchObject({ code: 'entity-create-failed', message: expect.stringContaining('Paseo is unreachable') })

    expect(events).toEqual([])
    expect(await gateway.getCanvas(project.id)).toEqual(before)
    expect(await (await open()).getCanvas(project.id)).toEqual(before)
  })
})

test('rejects a doomed creation before asking the entity adapter for a resource', async () => {
  await withFixture(async ({ projectDirectory, open }) => {
    const gateway = await open()
    const { project } = await gateway.createProject(await projectDirectory('doomed'))
    const adapter = recordingAdapter(WEB_PAGE_ENTITY, async () => ({ resourceRef: null }))
    gateway.registerEntityAdapter(adapter)
    const page = { entityType: WEB_PAGE_ENTITY, config: { url: 'https://example.com' } }

    await expectCode(
      gateway.execute(project.id, { type: 'spawnChild', sourceNodeId: 'gone', node: page, origin: 'spawned' }, user),
      'unknown-node'
    )
    const { nodeId } = await gateway.execute(project.id, { type: 'startTree', node: note('source') }, user)
    await expectCode(
      gateway.execute(
        project.id,
        { type: 'spawnChild', sourceNodeId: nodeId!, node: page, target: { kind: 'child', parentNodeId: 'gone' }, origin: 'spawned' },
        user
      ),
      'unknown-node'
    )
    await expectCode(
      gateway.execute(project.id, { type: 'startTree', node: { ...page, config: { url: 'ftp://example.com' } } }, user),
      'invalid-config'
    )
    await expectCode(
      gateway.execute(project.id, { type: 'startTree', node: { ...page, workspaceId: 'no-such-workspace' } }, user),
      'unknown-workspace'
    )
    await expectCode(gateway.execute('missing-project', { type: 'startTree', node: page }, user), 'unknown-project')
    expect(adapter.calls).toEqual([])
  })
})

test('rejects malformed commands and unknown projects without changing any canvas', async () => {
  await withFixture(async ({ projectDirectory, open }) => {
    const gateway = await open()
    const { project } = await gateway.createProject(await projectDirectory('strict'))
    const before = await gateway.getCanvas(project.id)

    await expectCode(gateway.execute(project.id, { type: 'explode' } as unknown as CanvasCommand, user), 'invalid-command')
    await expectCode(
      gateway.execute(project.id, { type: 'startTree', node: note('x'), extra: true } as unknown as CanvasCommand, user),
      'invalid-command'
    )
    await expectCode(gateway.execute(project.id, { type: 'startTree', node: { entityType: 'nope', config: {} } }, user), 'unknown-entity-type')
    await expectCode(gateway.execute('missing', { type: 'startTree', node: note('x') }, user), 'unknown-project')
    await expectCode(gateway.getCanvas('missing'), 'unknown-project')

    expect(await gateway.getCanvas(project.id)).toEqual(before)
  })
})

test('publishes applied commands with their actor and records agent changes in the activity', async () => {
  await withFixture(async ({ projectDirectory, open }) => {
    const gateway = await open()
    const { project } = await gateway.createProject(await projectDirectory('attributed'))
    const events: WorkspaceGatewayEvent[] = []
    gateway.subscribe((event) => events.push(event))

    const command: CanvasCommand = { type: 'startTree', node: note('by agent') }
    const { nodeId } = await gateway.execute(project.id, command, agent)
    const canvas = await gateway.getCanvas(project.id)

    expect(canvas.activity.at(-1)).toMatchObject({ actor: agent, command: 'startTree', nodeIds: [nodeId] })
    expect(events).toEqual([{ type: 'canvas-changed', canvas, command, actor: agent }])

    // A command that changes nothing is neither persisted nor published.
    const position = canvas.nodes[0].position
    await gateway.execute(project.id, { type: 'moveNodes', moves: [{ nodeId: nodeId!, position }] }, user)
    expect(events).toHaveLength(1)
    expect(await gateway.getCanvas(project.id)).toBe(canvas)
  })
})

test('restores projects, selection, settings and canvases in a fresh gateway over the same directory', async () => {
  await withFixture(async ({ projectDirectory, open }) => {
    const gateway = await open()
    const events: WorkspaceGatewayEvent[] = []
    gateway.subscribe((event) => events.push(event))
    const alpha = (await gateway.createProject(await projectDirectory('alpha'))).project
    const beta = (await gateway.createProject(await projectDirectory('beta'))).project
    await gateway.execute(alpha.id, { type: 'startTree', node: note('alpha note') }, user)
    await gateway.execute(beta.id, { type: 'startTree', node: note('beta note') }, user)
    await gateway.execute(beta.id, { type: 'setViewport', viewport: { x: 10, y: 20, zoom: 0.5 } }, user)
    await gateway.selectProject(alpha.id)
    await gateway.updateSettings({ paseoUrl: 'ws://127.0.0.1:9999' })
    await expectCode(gateway.updateSettings({ paseoUrl: 42 } as never), 'invalid-argument')
    await expectCode(gateway.updateSettings({ unknownSetting: true } as never), 'invalid-argument')
    expect(events.map((event) => event.type)).toContain('projects-changed')
    expect(events.map((event) => event.type)).toContain('settings-changed')
    await gateway.flush()

    const reopened = await open()
    expect(reopened.listProjects()).toEqual([alpha, beta])
    expect(reopened.selectedProjectId()).toBe(alpha.id)
    expect(reopened.getSettings().paseoUrl).toBe('ws://127.0.0.1:9999')
    expect(await reopened.getCanvas(alpha.id)).toEqual(await gateway.getCanvas(alpha.id))
    expect(await reopened.getCanvas(beta.id)).toEqual(await gateway.getCanvas(beta.id))
    expect((await reopened.getCanvas(beta.id)).viewport).toEqual({ x: 10, y: 20, zoom: 0.5 })
    expect(reopened.problems()).toEqual([])
  })
})

test('starts from empty records and reports a problem when a stored file is corrupt', async () => {
  await withFixture(async ({ dataDirectory, projectDirectory, open }) => {
    const first = await open()
    const { project } = await first.createProject(await projectDirectory('damaged'))
    await first.execute(project.id, { type: 'startTree', node: note('lost') }, user)
    await first.flush()

    await writeFile(join(dataDirectory, 'canvases', `${project.id}.json`), '{ not json')
    const second = await open()
    expect(second.listProjects()).toEqual([project])
    expect((await second.getCanvas(project.id)).nodes).toEqual([])
    expect(second.problems()).toEqual([
      { code: 'corrupt-data', projectId: project.id, message: expect.stringContaining('backups') }
    ])
    await second.execute(project.id, { type: 'startTree', node: note('after recovery') }, user)

    await writeFile(join(dataDirectory, 'index.json'), 'garbage')
    const third = await open()
    expect(third.listProjects()).toEqual([])
    expect(third.problems()).toEqual([{ code: 'corrupt-data', projectId: null, message: expect.any(String) }])
    await third.createProject(await projectDirectory('fresh'))

    const backups = await readdir(join(dataDirectory, 'backups'))
    expect(backups.filter((name) => name.startsWith('corrupt-'))).toHaveLength(2)
  })
})

test('leaves a canvas written by a newer SPADE untouched and unavailable', async () => {
  await withFixture(async ({ dataDirectory, projectDirectory, open }) => {
    const first = await open()
    const { project } = await first.createProject(await projectDirectory('future'))
    const other = (await first.createProject(await projectDirectory('present'))).project
    await first.flush()
    const canvasPath = join(dataDirectory, 'canvases', `${project.id}.json`)
    const future = `${JSON.stringify({ version: 99, projectId: project.id, nodes: [] })}\n`
    await writeFile(canvasPath, future)

    const gateway = await open()
    await expectCode(gateway.getCanvas(project.id), 'canvas-unavailable')
    await expectCode(gateway.execute(project.id, { type: 'startTree', node: note('blocked') }, user), 'canvas-unavailable')
    expect(gateway.problems()).toEqual([
      { code: 'unsupported-version', projectId: project.id, message: expect.stringContaining('newer SPADE') }
    ])
    await gateway.execute(other.id, { type: 'startTree', node: note('fine') }, user)
    expect(await gateway.findNode('no-such-node')).toBeNull()

    await gateway.removeProject(project.id)
    expect(gateway.problems()).toEqual([])
    expect(await readFile(canvasPath, 'utf8')).toBe(future)
  })
})

test('finds nodes by resource and by id across every project', async () => {
  await withFixture(async ({ projectDirectory, open }) => {
    const gateway = await open()
    const alpha = (await gateway.createProject(await projectDirectory('alpha'))).project
    const beta = (await gateway.createProject(await projectDirectory('beta'))).project
    const ref = { provider: 'paseo', kind: 'agent', id: 'agent-42' }
    await gateway.execute(alpha.id, { type: 'startTree', node: note('alpha') }, user)
    const { nodeId } = await gateway.execute(beta.id, { type: 'startTree', node: note('beta', { resourceRef: ref }) }, user)

    const reopened = await open()
    const byResource = await reopened.findNodeByResource({ ...ref, revision: 'any' })
    expect(byResource).toMatchObject({ projectId: beta.id, node: { id: nodeId, resourceRef: ref } })
    expect(await reopened.findNode(nodeId!)).toEqual(byResource)
    expect(await reopened.findNodeByResource({ ...ref, id: 'agent-43' })).toBeNull()
  })
})

test('names a new project after its directory', async () => {
  await withFixture(async ({ projectDirectory, open }) => {
    const gateway = await open()
    const root = await projectDirectory('My Framework')
    const { project } = await gateway.createProject(root)
    expect(project.name).toBe(basename(root))
    await expect(gateway.createProject('relative/path')).rejects.toBeInstanceOf(WorkspaceError)
    await expectCode(gateway.createProject('relative/path'), 'invalid-argument')
    expect(gateway.listProjects()).toHaveLength(1)
  })
})
