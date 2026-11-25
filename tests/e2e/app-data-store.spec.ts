import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  AppDataStore,
  AssetStore,
  CorruptDataError,
  InvalidIdError,
  InvalidRecordError,
  UnsupportedVersionError,
  nodeFileOperations,
  type AppIndex,
  type PersistenceFileOperations
} from '../../src/main/persistence'
import {
  CANVAS_ACTIVITY_LIMIT,
  DEFAULT_APP_SETTINGS,
  DOMAIN_RECORD_VERSION,
  createEmptyCanvas,
  type Canvas,
  type CanvasNode,
  type Project
} from '../../src/shared/domain'

const createdAt = '2026-01-01T00:00:00.000Z'
const fixedNow = new Date('2026-11-21T10:15:30.123Z')
const fixedStamp = '2026-11-21T10-15-30-123Z'

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'spade-app-data-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
}

function project(id: string, name = id): Project {
  return { version: DOMAIN_RECORD_VERSION, id, name, rootPath: `C:\\work\\${name}`, createdAt }
}

function node(projectId: string, id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    version: DOMAIN_RECORD_VERSION,
    id,
    entityType: 'note',
    entityVersion: 1,
    title: `Note ${id}`,
    position: { x: 10, y: 20 },
    collapsed: false,
    branchCollapsed: false,
    archived: false,
    projectId,
    groupId: null,
    workspaceId: null,
    config: { body: 'hello' },
    resourceRef: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides
  }
}

function populatedCanvas(projectId: string): Canvas {
  return {
    ...createEmptyCanvas(projectId),
    nodes: [
      node(projectId, 'root', {
        workspaceId: 'workspace-1',
        size: { width: 320, height: 200 },
        shortDescription: 'The root',
        resourceRef: { provider: 'paseo', kind: 'agent', id: 'agent-1', revision: 'r1' },
        cachedPresentation: { summary: 'Working', updatedAt: createdAt }
      }),
      node(projectId, 'child')
    ],
    edges: [
      {
        version: DOMAIN_RECORD_VERSION,
        id: 'edge-1',
        fromNodeId: 'root',
        toNodeId: 'child',
        relation: 'child',
        origin: 'artifact',
        sourceArtifact: { kind: 'path', value: 'C:\\work\\shot.png' },
        createdAt
      }
    ],
    workspaces: [
      {
        version: DOMAIN_RECORD_VERSION,
        id: 'workspace-1',
        projectId,
        cwd: 'C:\\work',
        paseoWorkspaceId: 'wks_1',
        name: 'work',
        createdAt
      }
    ],
    viewport: { x: -40, y: 12.5, zoom: 0.75 },
    activity: [
      {
        id: 'activity-1',
        at: createdAt,
        actor: { kind: 'agent', nodeId: 'root', agentId: 'agent-1' },
        command: 'spawnChild',
        summary: 'Spawned Note',
        nodeIds: ['child']
      },
      {
        id: 'activity-2',
        at: createdAt,
        // An agent collapsed into its owner's list acts without a node of its own.
        actor: { kind: 'agent', nodeId: null, agentId: 'agent-2' },
        command: 'spawnChild',
        summary: 'Spawned Note',
        nodeIds: ['child']
      }
    ]
  }
}

function index(projects: Project[], selectedProjectId: string | null = null): AppIndex {
  return {
    version: DOMAIN_RECORD_VERSION,
    projects,
    settings: {
      ...DEFAULT_APP_SETTINGS,
      agentDefaults: { provider: 'claude', model: 'opus', mode: null },
      paseoUrl: 'ws://127.0.0.1:6767'
    },
    selectedProjectId
  }
}

test('loading from an empty directory yields defaults and creates nothing', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new AppDataStore({ directory })

    expect(await store.loadIndex()).toEqual({
      version: DOMAIN_RECORD_VERSION,
      projects: [],
      settings: DEFAULT_APP_SETTINGS,
      selectedProjectId: null
    })
    expect(await store.loadCanvas('project-1')).toEqual(createEmptyCanvas('project-1'))
    expect(await listFiles(directory)).toEqual([])
  })
})

test('the app index and each project canvas round-trip through separate files', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new AppDataStore({ directory })
    const savedIndex = index([project('alpha'), project('beta')], 'beta')
    const alpha = populatedCanvas('alpha')
    const beta = { ...createEmptyCanvas('beta'), nodes: [node('beta', 'only')] }

    await store.saveIndex(savedIndex)
    await store.saveCanvas(alpha)
    await store.saveCanvas(beta)

    expect(await listFiles(directory)).toEqual(['canvases/alpha.json', 'canvases/beta.json', 'index.json'])

    const reopened = new AppDataStore({ directory })
    expect(await reopened.loadIndex()).toEqual(savedIndex)
    expect(await reopened.loadCanvas('alpha')).toEqual(alpha)
    expect(await reopened.loadCanvas('beta')).toEqual(beta)
  })
})

test('settings missing from a stored index are filled with their defaults', async () => {
  await withTemporaryDirectory(async (directory) => {
    await writeFile(
      join(directory, 'index.json'),
      JSON.stringify({
        version: DOMAIN_RECORD_VERSION,
        projects: [],
        settings: { paseoUrl: 'ws://remote:6767', conversationExpansion: { read: true } },
        selectedProjectId: null
      })
    )

    const loaded = await new AppDataStore({ directory }).loadIndex()

    expect(loaded.settings).toEqual({
      agentDefaults: null,
      conversationExpansion: { toolCall: true, diff: true, html: true, thinking: true, read: true },
      paseoUrl: 'ws://remote:6767'
    })
  })
})

test('deleting a project canvas leaves the other canvases in place', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new AppDataStore({ directory })
    await store.saveCanvas(populatedCanvas('alpha'))
    await store.saveCanvas(populatedCanvas('beta'))

    await store.deleteCanvas('alpha')
    await store.deleteCanvas('never-saved')

    expect(await listFiles(directory)).toEqual(['canvases/beta.json'])
    expect(await store.loadCanvas('alpha')).toEqual(createEmptyCanvas('alpha'))
    expect(await store.loadCanvas('beta')).toEqual(populatedCanvas('beta'))
  })
})

test('concurrent saves of one file run one at a time in call order and the last one wins', async () => {
  await withTemporaryDirectory(async (directory) => {
    const canvasPath = join(directory, 'canvases', 'alpha.json')
    let active = 0
    let maxActive = 0
    const renamedTitles: string[] = []
    const files: PersistenceFileOperations = {
      ...nodeFileOperations,
      writeNewFile: async (path, data) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        await nodeFileOperations.writeNewFile(path, data)
      },
      rename: async (from, to) => {
        await nodeFileOperations.rename(from, to)
        if (to === canvasPath) {
          renamedTitles.push((JSON.parse(await readFile(to, 'utf8')) as Canvas).nodes[0].title)
        }
        active -= 1
      }
    }
    const store = new AppDataStore({ directory, files })
    const titles = ['one', 'two', 'three', 'four', 'five']

    await Promise.all(
      titles.map((title) => store.saveCanvas({ ...createEmptyCanvas('alpha'), nodes: [node('alpha', 'n', { title })] }))
    )

    expect(maxActive).toBe(1)
    expect(renamedTitles).toEqual(titles)
    expect((await store.loadCanvas('alpha')).nodes[0].title).toBe('five')
  })
})

test('a save captures the record at call time even if the caller mutates it afterwards', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new AppDataStore({ directory })
    const canvas = populatedCanvas('alpha')

    const saving = store.saveCanvas(canvas)
    canvas.nodes[0].title = 'mutated after save'
    await saving

    expect((await store.loadCanvas('alpha')).nodes[0].title).toBe('Note root')
  })
})

test('flush waits for every pending write', async () => {
  await withTemporaryDirectory(async (directory) => {
    const files: PersistenceFileOperations = {
      ...nodeFileOperations,
      writeNewFile: async (path, data) => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        await nodeFileOperations.writeNewFile(path, data)
      }
    }
    const store = new AppDataStore({ directory, files })

    void store.saveIndex(index([project('alpha')]))
    void store.saveCanvas(populatedCanvas('alpha'))
    void store.saveCanvas({ ...createEmptyCanvas('alpha'), nodes: [node('alpha', 'last')] })
    await store.flush()

    expect(JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'))).toEqual(index([project('alpha')]))
    expect(JSON.parse(await readFile(join(directory, 'canvases', 'alpha.json'), 'utf8')).nodes[0].id).toBe('last')
  })
})

test('a failed write or rename keeps the previous file and leaves no temporary file', async () => {
  await withTemporaryDirectory(async (directory) => {
    const original = populatedCanvas('alpha')
    await new AppDataStore({ directory }).saveCanvas(original)
    const replacement = { ...createEmptyCanvas('alpha'), nodes: [node('alpha', 'replacement')] }

    const failingOperations: Array<[string, PersistenceFileOperations]> = [
      [
        'injected write failure',
        {
          ...nodeFileOperations,
          writeNewFile: async (path) => {
            await nodeFileOperations.writeNewFile(path, '{"partial":')
            throw new Error('injected write failure')
          }
        }
      ],
      [
        'injected rename failure',
        {
          ...nodeFileOperations,
          rename: async () => {
            throw new Error('injected rename failure')
          }
        }
      ]
    ]

    for (const [failure, files] of failingOperations) {
      const store = new AppDataStore({ directory, files })

      await expect(store.saveCanvas(replacement)).rejects.toThrow(failure)

      expect(await listFiles(directory)).toEqual(['canvases/alpha.json'])
      expect(await new AppDataStore({ directory }).loadCanvas('alpha')).toEqual(original)
    }
  })
})

test('a failed save does not block later saves of the same file', async () => {
  await withTemporaryDirectory(async (directory) => {
    let failNext = true
    const files: PersistenceFileOperations = {
      ...nodeFileOperations,
      rename: async (from, to) => {
        if (failNext) {
          failNext = false
          throw new Error('injected rename failure')
        }
        await nodeFileOperations.rename(from, to)
      }
    }
    const store = new AppDataStore({ directory, files })

    const first = store.saveCanvas(populatedCanvas('alpha'))
    const second = store.saveCanvas({ ...createEmptyCanvas('alpha'), nodes: [node('alpha', 'second')] })

    await expect(first).rejects.toThrow('injected rename failure')
    await second
    expect((await store.loadCanvas('alpha')).nodes.map((saved) => saved.id)).toEqual(['second'])
  })
})

test('malformed records are refused before anything is written', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new AppDataStore({ directory })
    const valid = populatedCanvas('alpha')
    await store.saveCanvas(valid)
    const before = await readFile(join(directory, 'canvases', 'alpha.json'), 'utf8')

    const malformedCanvases: unknown[] = [
      { ...valid, nodes: [{ ...valid.nodes[0], title: undefined }] },
      { ...valid, nodes: [{ ...valid.nodes[0], position: { x: Number.NaN, y: 0 } }] },
      { ...valid, nodes: [{ ...valid.nodes[0], selected: true }] },
      { ...valid, nodes: [{ ...valid.nodes[0], projectId: 'beta' }] },
      { ...valid, nodes: [...valid.nodes, valid.nodes[1]] },
      { ...valid, nodes: [{ ...valid.nodes[0], workspaceId: 'missing-workspace' }] },
      { ...valid, edges: [{ ...valid.edges[0], toNodeId: 'missing-node' }] },
      { ...valid, edges: [{ ...valid.edges[0], relation: 'parent' }] },
      { ...valid, edges: [...valid.edges, { ...valid.edges[0], id: 'edge-2', fromNodeId: 'child', toNodeId: 'root' }] },
      { ...valid, viewport: { x: 0, y: 0, zoom: 0 } },
      { ...valid, version: 1 },
      { ...valid, activity: Array.from({ length: CANVAS_ACTIVITY_LIMIT + 1 }, () => valid.activity[0]) },
      { ...valid, activity: [{ ...valid.activity[0], actor: { kind: 'robot' } }] },
      { ...valid, activity: [{ ...valid.activity[0], actor: { kind: 'agent', nodeId: '', agentId: 'agent-1' } }] },
      { ...valid, activity: [{ ...valid.activity[0], actor: { kind: 'agent', agentId: 'agent-1' } }] },
      { ...valid, dismissedResources: [] }
    ]
    for (const malformed of malformedCanvases) {
      await expect(store.saveCanvas(malformed as Canvas)).rejects.toBeInstanceOf(InvalidRecordError)
    }

    const malformedIndexes: unknown[] = [
      { ...index([project('alpha')]), selectedProjectId: 'missing-project' },
      index([project('alpha'), project('alpha')]),
      { ...index([]), settings: { ...DEFAULT_APP_SETTINGS, paseoUrl: 42 } },
      { ...index([]), extra: true }
    ]
    for (const malformed of malformedIndexes) {
      await expect(store.saveIndex(malformed as AppIndex)).rejects.toBeInstanceOf(InvalidRecordError)
    }

    expect(await readFile(join(directory, 'canvases', 'alpha.json'), 'utf8')).toBe(before)
    expect(await listFiles(directory)).toEqual(['canvases/alpha.json'])
  })
})

test('ids that are not safe file names are rejected everywhere they would name a file', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new AppDataStore({ directory })
    const unsafeIds = ['', '.', '..', '../escape', 'a/b', 'a\\b', 'C:', 'a.b', 'with space', 'x'.repeat(129), 'CON', 'nul', 'com1']

    for (const id of unsafeIds) {
      await expect(store.loadCanvas(id)).rejects.toBeInstanceOf(InvalidIdError)
      await expect(store.saveCanvas(createEmptyCanvas(id))).rejects.toBeInstanceOf(InvalidIdError)
      await expect(store.deleteCanvas(id)).rejects.toBeInstanceOf(InvalidIdError)
      await expect(store.saveIndex(index([project(id, 'unsafe')]))).rejects.toBeInstanceOf(InvalidRecordError)
    }

    await expect(store.saveCanvas(createEmptyCanvas('x'.repeat(128)))).resolves.toBeUndefined()
    expect(await listFiles(directory)).toEqual([`canvases/${'x'.repeat(128)}.json`])
  })
})

test('an older file is backed up before it is migrated and the migrated form is persisted', async () => {
  await withTemporaryDirectory(async (directory) => {
    const legacyVersion = DOMAIN_RECORD_VERSION - 1
    const legacy = `${JSON.stringify({ version: legacyVersion, projectId: 'alpha', items: [] }, null, 2)}\n`
    await mkdir(join(directory, 'canvases'), { recursive: true })
    await writeFile(join(directory, 'canvases', 'alpha.json'), legacy)
    const migrations = {
      canvas: [
        {
          fromVersion: legacyVersion,
          migrate: (document: Record<string, unknown>) => {
            const migrated = { ...createEmptyCanvas(String(document.projectId)) } as Record<string, unknown>
            migrated.nodes = document.items
            return migrated
          }
        }
      ]
    }
    const store = new AppDataStore({ directory, now: () => fixedNow, migrations })

    expect(await store.loadCanvas('alpha')).toEqual(createEmptyCanvas('alpha'))

    const backupName = `canvas-alpha.v${legacyVersion}.${fixedStamp}.json`
    expect(await listFiles(directory)).toEqual([`backups/${backupName}`, 'canvases/alpha.json'])
    expect(await readFile(join(directory, 'backups', backupName), 'utf8')).toBe(legacy)
    expect(JSON.parse(await readFile(join(directory, 'canvases', 'alpha.json'), 'utf8'))).toEqual(
      createEmptyCanvas('alpha')
    )

    await store.loadCanvas('alpha')
    await new AppDataStore({ directory, now: () => fixedNow, migrations }).loadCanvas('alpha')
    expect(await listFiles(directory)).toEqual([`backups/${backupName}`, 'canvases/alpha.json'])
  })
})

test('an older file with no registered migration is refused and left untouched', async () => {
  await withTemporaryDirectory(async (directory) => {
    // Format 1 was never persisted, so nothing migrates from it.
    const legacy = JSON.stringify({ version: 1, projects: [] })
    await writeFile(join(directory, 'index.json'), legacy)
    const store = new AppDataStore({ directory })

    const failure = await store.loadIndex().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(UnsupportedVersionError)
    expect(failure).toMatchObject({ foundVersion: 1, supportedVersion: DOMAIN_RECORD_VERSION })
    await expect(store.saveIndex(index([]))).rejects.toBeInstanceOf(UnsupportedVersionError)
    expect(await readFile(join(directory, 'index.json'), 'utf8')).toBe(legacy)
    expect(await listFiles(directory)).toEqual(['index.json'])
  })
})

test('format 2 files load as the current format: canvases drop the dismissed-resource list, nested records are restamped', async () => {
  await withTemporaryDirectory(async (directory) => {
    const current = populatedCanvas('alpha')
    const restamp = <Value extends object>(records: Value[]) => records.map((record) => ({ ...record, version: 2 }))
    const formatTwoCanvas = {
      ...current,
      version: 2,
      nodes: restamp(current.nodes),
      edges: restamp(current.edges),
      workspaces: restamp(current.workspaces),
      // Format 2 canvases recorded only agents shown by the canvas, never with nodeId null.
      activity: current.activity.slice(0, 1),
      dismissedResources: [{ provider: 'paseo', kind: 'agent', id: 'agent-removed' }]
    }
    const currentIndex = index([project('alpha')], 'alpha')
    const formatTwoIndex = { ...currentIndex, version: 2, projects: restamp(currentIndex.projects) }
    await mkdir(join(directory, 'canvases'), { recursive: true })
    await writeFile(join(directory, 'canvases', 'alpha.json'), JSON.stringify(formatTwoCanvas))
    await writeFile(join(directory, 'index.json'), JSON.stringify(formatTwoIndex))

    const store = new AppDataStore({ directory, now: () => fixedNow })
    const expectedCanvas = { ...current, activity: current.activity.slice(0, 1) }
    expect(await store.loadCanvas('alpha')).toEqual(expectedCanvas)
    expect(await store.loadIndex()).toEqual(currentIndex)

    expect(await listFiles(directory)).toEqual([
      `backups/canvas-alpha.v2.${fixedStamp}.json`,
      `backups/index.v2.${fixedStamp}.json`,
      'canvases/alpha.json',
      'index.json'
    ])
    const persisted = JSON.parse(await readFile(join(directory, 'canvases', 'alpha.json'), 'utf8'))
    expect(persisted).toEqual(expectedCanvas)
    expect(persisted).not.toHaveProperty('dismissedResources')
  })
})

test('a file written by a newer version is refused and never overwritten', async () => {
  await withTemporaryDirectory(async (directory) => {
    const newerVersion = DOMAIN_RECORD_VERSION + 1
    const newerIndex = JSON.stringify({ version: newerVersion, projects: [], futureField: true })
    const newerCanvas = JSON.stringify({ version: newerVersion, projectId: 'alpha' })
    await mkdir(join(directory, 'canvases'), { recursive: true })
    await writeFile(join(directory, 'index.json'), newerIndex)
    await writeFile(join(directory, 'canvases', 'alpha.json'), newerCanvas)

    const store = new AppDataStore({ directory })
    const failure = await store.loadIndex().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(UnsupportedVersionError)
    expect(failure).toMatchObject({ foundVersion: newerVersion, supportedVersion: DOMAIN_RECORD_VERSION })
    expect(String((failure as Error).message)).toContain('newer')
    await expect(store.saveIndex(index([]))).rejects.toBeInstanceOf(UnsupportedVersionError)

    await expect(store.loadCanvas('alpha')).rejects.toBeInstanceOf(UnsupportedVersionError)
    await expect(store.saveCanvas(createEmptyCanvas('alpha'))).rejects.toBeInstanceOf(UnsupportedVersionError)

    const unloadedStore = new AppDataStore({ directory })
    await expect(unloadedStore.saveIndex(index([]))).rejects.toBeInstanceOf(UnsupportedVersionError)
    await expect(unloadedStore.saveCanvas(createEmptyCanvas('alpha'))).rejects.toBeInstanceOf(UnsupportedVersionError)

    expect(await readFile(join(directory, 'index.json'), 'utf8')).toBe(newerIndex)
    expect(await readFile(join(directory, 'canvases', 'alpha.json'), 'utf8')).toBe(newerCanvas)
    expect(await listFiles(directory)).toEqual(['canvases/alpha.json', 'index.json'])
  })
})

test('a corrupt file is moved aside, reported with its backup path, and never replaced silently', async () => {
  await withTemporaryDirectory(async (directory) => {
    const notJson = '{"version": 2, "projects": ['
    const invalidCanvas = JSON.stringify({ ...createEmptyCanvas('alpha'), nodes: [{ id: 'no-fields' }] })
    await mkdir(join(directory, 'canvases'), { recursive: true })
    await writeFile(join(directory, 'index.json'), notJson)
    await writeFile(join(directory, 'canvases', 'alpha.json'), invalidCanvas)
    await writeFile(join(directory, 'canvases', 'beta.json'), JSON.stringify(createEmptyCanvas('gamma')))
    const store = new AppDataStore({ directory, now: () => fixedNow })

    const indexFailure = await store.loadIndex().catch((error: unknown) => error)
    const canvasFailure = await store.loadCanvas('alpha').catch((error: unknown) => error)
    const mismatchFailure = await store.loadCanvas('beta').catch((error: unknown) => error)

    expect(indexFailure).toBeInstanceOf(CorruptDataError)
    expect(canvasFailure).toBeInstanceOf(CorruptDataError)
    expect(mismatchFailure).toBeInstanceOf(CorruptDataError)
    const indexBackup = join(directory, 'backups', `corrupt-index.${fixedStamp}.json`)
    const canvasBackup = join(directory, 'backups', `corrupt-canvas-alpha.${fixedStamp}.json`)
    expect(indexFailure).toMatchObject({ filePath: join(directory, 'index.json'), backupPath: indexBackup })
    expect(canvasFailure).toMatchObject({ filePath: join(directory, 'canvases', 'alpha.json'), backupPath: canvasBackup })
    expect(await readFile(indexBackup, 'utf8')).toBe(notJson)
    expect(await readFile(canvasBackup, 'utf8')).toBe(invalidCanvas)
    expect(await listFiles(directory)).toEqual([
      `backups/corrupt-canvas-alpha.${fixedStamp}.json`,
      `backups/corrupt-canvas-beta.${fixedStamp}.json`,
      `backups/corrupt-index.${fixedStamp}.json`
    ])

    expect(await store.loadIndex()).toEqual({
      version: DOMAIN_RECORD_VERSION,
      projects: [],
      settings: DEFAULT_APP_SETTINGS,
      selectedProjectId: null
    })
    expect(await store.loadCanvas('alpha')).toEqual(createEmptyCanvas('alpha'))
  })
})

test('backups made at the same instant never overwrite each other', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new AppDataStore({ directory, now: () => fixedNow })

    for (const content of ['first corrupt', 'second corrupt']) {
      await writeFile(join(directory, 'index.json'), content)
      await expect(store.loadIndex()).rejects.toBeInstanceOf(CorruptDataError)
    }

    const backups = await listFiles(join(directory, 'backups'))
    expect(backups).toHaveLength(2)
    const contents = await Promise.all(backups.map((name) => readFile(join(directory, 'backups', name), 'utf8')))
    expect(contents.sort()).toEqual(['first corrupt', 'second corrupt'])
  })
})

test('a full exercise of both stores never touches a path outside the store directory', async () => {
  await withTemporaryDirectory(async (parent) => {
    const directory = join(parent, 'store')
    const touched: string[] = []
    const record =
      <Args extends string[], Result>(operation: (...args: Args) => Promise<Result>) =>
      async (...args: Args): Promise<Result> => {
        touched.push(...args.filter((arg): arg is string => typeof arg === 'string'))
        return operation(...args)
      }
    const files: PersistenceFileOperations = {
      mkdir: record(nodeFileOperations.mkdir),
      readFile: record(nodeFileOperations.readFile),
      writeNewFile: async (path, data) => {
        touched.push(path)
        await nodeFileOperations.writeNewFile(path, data)
      },
      rename: record(nodeFileOperations.rename),
      copyFile: record(nodeFileOperations.copyFile),
      unlink: record(nodeFileOperations.unlink),
      exists: record(nodeFileOperations.exists)
    }
    const migrations = {
      index: [{ fromVersion: DOMAIN_RECORD_VERSION - 1, migrate: (document: Record<string, unknown>) => document }]
    }
    const store = new AppDataStore({ directory, files, migrations })
    const assets = new AssetStore({ directory, files })

    await store.loadIndex()
    await store.saveIndex(index([project('alpha'), project('beta')], 'alpha'))
    await store.saveCanvas(populatedCanvas('alpha'))
    await store.saveCanvas(populatedCanvas('beta'))
    await store.deleteCanvas('beta')
    await writeFile(join(directory, 'canvases', 'beta.json'), 'not json')
    await expect(store.loadCanvas('beta')).rejects.toBeInstanceOf(CorruptDataError)
    await writeFile(
      join(directory, 'index.json'),
      JSON.stringify({ ...index([project('alpha')]), version: DOMAIN_RECORD_VERSION - 1 })
    )
    await store.loadIndex()
    for (const id of ['../escape', '..', 'a/b']) {
      await expect(store.loadCanvas(id)).rejects.toBeInstanceOf(InvalidIdError)
      expect(await assets.resolve(id)).toBeNull()
    }
    const { assetId } = await assets.import({ data: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' })
    await assets.resolve(assetId)
    await store.flush()

    expect(touched.length).toBeGreaterThan(0)
    for (const path of touched) {
      expect(relative(directory, path).startsWith('..'), path).toBe(false)
    }
    const everything = await listFiles(parent)
    expect(everything.length).toBeGreaterThan(0)
    for (const file of everything) {
      expect(file.startsWith('store/'), file).toBe(true)
    }
  })
})
