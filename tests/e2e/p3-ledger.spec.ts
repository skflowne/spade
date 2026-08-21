import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createInitialLedger } from '../../prototypes/paseo-issue-to-pr-bridge/shared/commands'
import { PrototypeCommandService } from '../../prototypes/paseo-issue-to-pr-bridge/main/commandService'
import { LedgerStore, nodeLedgerFileOperations } from '../../prototypes/paseo-issue-to-pr-bridge/main/ledgerStore'
import {
  isPrototypeLedger,
  type PrototypeLedger
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/model'

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'spade-p3-ledger-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('atomically replaces and reloads the exact prototype ledger without duplication', async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, 'ledger.json')
    const store = new LedgerStore(path)
    const ledger = {
      ...createInitialLedger('project-1', 'Prototype project'),
      nextSequence: 3,
      nodes: [
        {
          id: 'node-1',
          projectId: 'project-1',
          groupId: null,
          workItemId: null,
          kind: 'agent' as const,
          title: 'Root agent',
          position: { x: 120, y: 160 },
          resourceRef: {
            provider: 'placeholder',
            kind: 'agent',
            id: 'external-agent-9',
            revision: 'opaque-revision'
          },
          paseo: null
        }
      ],
      edges: [
        {
          id: 'edge-2',
          fromNodeId: 'node-1',
          toNodeId: 'node-1',
          relation: 'connected' as const
        }
      ]
    }

    await store.save(ledger)
    await store.save(ledger)

    expect(await store.load()).toEqual(ledger)
    expect((await store.load())?.nodes).toHaveLength(1)
    expect((await store.load())?.edges).toHaveLength(1)
    expect((await store.load())?.nodes[0].resourceRef).toEqual(ledger.nodes[0].resourceRef)
  })
})

test('a failed temporary write leaves the prior ledger readable', async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, 'ledger.json')
    const original = createInitialLedger('project-1', 'Original')
    const store = new LedgerStore(path)
    await store.save(original)

    const failingStore = new LedgerStore(path, {
      ...nodeLedgerFileOperations,
      writeFile: async () => {
        throw new Error('injected write failure')
      }
    })

    await expect(failingStore.save(createInitialLedger('project-2', 'Replacement'))).rejects.toThrow(
      'injected write failure'
    )
    expect(await store.load()).toEqual(original)
  })
})

test('a failed atomic replace leaves the prior ledger readable and removes the temporary file', async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, 'ledger.json')
    const original = createInitialLedger('project-1', 'Original')
    const store = new LedgerStore(path)
    await store.save(original)

    let temporaryPath = ''
    const failingStore = new LedgerStore(path, {
      ...nodeLedgerFileOperations,
      writeFile: async (pathToWrite, data) => {
        temporaryPath = pathToWrite
        await writeFile(pathToWrite, data, 'utf8')
      },
      rename: async () => {
        throw new Error('injected replace failure')
      }
    })

    await expect(failingStore.save(createInitialLedger('project-2', 'Replacement'))).rejects.toThrow(
      'injected replace failure'
    )
    expect(await store.load()).toEqual(original)
    await expect(readFile(temporaryPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

test('rejects duplicate identities and collision-prone sequence state', () => {
  let ledger = createInitialLedger('project-1', 'Prototype project')
  ledger = {
    ...ledger,
    nextSequence: 5,
    groups: [
      {
        id: 'work-item-1',
        kind: 'work-item',
        projectId: 'project-1',
        name: 'Issue 17',
        position: { x: 100, y: 100 },
        task: 'Build shell',
        sourceRef: null,
        status: 'active'
      }
    ],
    nodes: [
      {
        id: 'node-2',
        projectId: 'project-1',
        groupId: 'work-item-1',
        workItemId: 'work-item-1',
        kind: 'agent',
        title: 'Agent',
        position: { x: 140, y: 180 },
        resourceRef: { provider: 'placeholder', kind: 'agent', id: 'external-1', revision: null },
        paseo: null
      },
      {
        id: 'node-3',
        projectId: 'project-1',
        groupId: 'work-item-1',
        workItemId: 'work-item-1',
        kind: 'workspace',
        title: 'Workspace',
        position: { x: 380, y: 180 },
        resourceRef: { provider: 'placeholder', kind: 'workspace', id: 'external-2', revision: null },
        paseo: null
      }
    ],
    edges: [{ id: 'edge-4', fromNodeId: 'node-2', toNodeId: 'node-3', relation: 'connected' }]
  }
  expect(isPrototypeLedger(ledger)).toBe(true)

  const invalidLedgers: PrototypeLedger[] = [
    { ...ledger, groups: [...ledger.groups, { ...ledger.groups[0] }] },
    { ...ledger, nodes: [...ledger.nodes, { ...ledger.nodes[1], id: 'node-2' }] },
    { ...ledger, edges: [...ledger.edges, { ...ledger.edges[0], id: 'edge-5' }] },
    {
      ...ledger,
      nodes: [
        ...ledger.nodes,
        { ...ledger.nodes[1], id: 'node-5', resourceRef: { ...ledger.nodes[0].resourceRef } }
      ],
      nextSequence: 6
    },
    { ...ledger, edges: [...ledger.edges, { ...ledger.edges[0], id: 'edge-5' }], nextSequence: 6 },
    {
      ...ledger,
      nodes: ledger.nodes.map((node) => node.id === 'node-2'
        ? {
            ...node,
            paseo: {
              type: 'managed-agent',
              state: 'connected',
              parentAgentId: null,
              workspaceId: null,
              provider: 'claude',
              model: 'model-1',
              status: 'idle',
              cwd: '/opaque/display/path',
              timeline: [
                {
                  id: 'seq:epoch-1:1:1',
                  timestamp: '2026-08-20T10:00:00Z',
                  epoch: 'epoch-1',
                  sequenceStart: 1,
                  sequenceEnd: 1,
                  kind: 'assistant-message',
                  summary: 'Done',
                  detail: 'Done',
                  initialExpanded: true
                },
                {
                  id: 'seq:epoch-1:1:1',
                  timestamp: '2026-08-20T10:00:00Z',
                  epoch: 'epoch-1',
                  sequenceStart: 1,
                  sequenceEnd: 1,
                  kind: 'assistant-message',
                  summary: 'Done',
                  detail: 'Done',
                  initialExpanded: true
                }
              ]
            }
          }
        : node)
    },
    { ...ledger, nextSequence: 4 }
  ]
  for (const invalid of invalidLedgers) expect(isPrototypeLedger(invalid)).toBe(false)
})

test('rejects duplicate opaque roots across WorkItem bindings', () => {
  const ledger = {
    ...createInitialLedger('project-1', 'Prototype project'),
    nextSequence: 3,
    groups: [
      {
        id: 'work-item-1',
        kind: 'work-item' as const,
        projectId: 'project-1',
        name: 'First',
        position: { x: 100, y: 100 },
        task: 'First owner',
        sourceRef: null,
        status: 'active' as const
      },
      {
        id: 'work-item-2',
        kind: 'work-item' as const,
        projectId: 'project-1',
        name: 'Second',
        position: { x: 600, y: 100 },
        task: 'Second owner',
        sourceRef: null,
        status: 'active' as const
      }
    ],
    paseo: {
      ...createInitialLedger('project-1', 'Prototype project').paseo,
      bindings: [
        { workItemId: 'work-item-1', rootAgentId: 'root-a' },
        { workItemId: 'work-item-2', rootAgentId: 'root-b' }
      ]
    }
  }
  expect(isPrototypeLedger(ledger)).toBe(true)
  expect(isPrototypeLedger({
    ...ledger,
    paseo: {
      ...ledger.paseo,
      bindings: ledger.paseo.bindings.map((binding) => ({ ...binding, rootAgentId: 'root-a' }))
    }
  })).toBe(false)
})

test('migrates a valid version 1 ledger without changing stable identities', async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, 'ledger.json')
    const versionOne = {
      version: 1,
      nextSequence: 4,
      project: { id: 'project-1', name: 'Prototype project' },
      groups: [
        {
          id: 'work-item-1',
          kind: 'work-item',
          projectId: 'project-1',
          name: 'Issue 17',
          position: { x: 100, y: 100 },
          task: 'Build shell',
          sourceRef: null,
          status: 'active'
        }
      ],
      nodes: [
        {
          id: 'node-2',
          projectId: 'project-1',
          groupId: 'work-item-1',
          workItemId: 'work-item-1',
          kind: 'agent',
          title: 'Root agent',
          position: { x: 140, y: 180 },
          resourceRef: { provider: 'placeholder', kind: 'agent', id: 'external-1', revision: null }
        }
      ],
      edges: [
        { id: 'edge-3', fromNodeId: 'node-2', toNodeId: 'node-2', relation: 'connected' }
      ]
    }
    await writeFile(path, JSON.stringify(versionOne), 'utf8')

    const migrated = await new LedgerStore(path).load()
    expect(migrated).toMatchObject({ version: 2, nextSequence: 4 })
    expect(migrated?.groups).toEqual(versionOne.groups)
    expect(migrated?.nodes[0]).toEqual({ ...versionOne.nodes[0], paseo: null })
    expect(migrated?.edges).toEqual(versionOne.edges)
    expect(migrated?.paseo.capabilities.find(({ name }) => name === 'live-timeline')).toMatchObject({
      state: 'unavailable'
    })
  })
})

test('rejects malformed ledgers instead of exposing partial records', async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, 'ledger.json')
    await writeFile(path, JSON.stringify({ version: 1, project: null }), 'utf8')

    await expect(new LedgerStore(path).load()).rejects.toThrow('Invalid P3 prototype ledger')
  })
})

test('failed initial persistence leaves the command service uninitialized', async () => {
  const service = new PrototypeCommandService({
    load: async () => null,
    save: async () => {
      throw new Error('injected initial save failure')
    }
  })

  await expect(service.initialize(createInitialLedger('project-1', 'Prototype project'))).rejects.toThrow(
    'injected initial save failure'
  )
  expect(() => service.snapshot()).toThrow('Prototype command service is not initialized.')
})

test('the command service serializes concurrent mutation and persistence sequences', async () => {
  const state: { stored: PrototypeLedger | null } = { stored: null }
  let releaseFirstSave = (): void => undefined
  let markFirstSaveStarted = (): void => undefined
  const firstSaveStarted = new Promise<void>((resolve) => {
    markFirstSaveStarted = resolve
  })
  const firstSaveReleased = new Promise<void>((resolve) => {
    releaseFirstSave = resolve
  })
  const service = new PrototypeCommandService({
    load: async () => state.stored,
    save: async (ledger) => {
      if (ledger.groups.some(({ name }) => name === 'First')) {
        markFirstSaveStarted()
        await firstSaveReleased
      }
      state.stored = structuredClone(ledger)
    }
  })
  await service.initialize(createInitialLedger('project-1', 'Prototype project'))

  const first = service.execute({ type: 'create-group', name: 'First' })
  await firstSaveStarted
  const second = service.execute({ type: 'create-group', name: 'Second' })
  releaseFirstSave()
  await Promise.all([first, second])

  expect(service.snapshot().groups.map(({ id, name }) => ({ id, name }))).toEqual([
    { id: 'group-1', name: 'First' },
    { id: 'group-2', name: 'Second' }
  ])
  expect(state.stored?.groups).toEqual(service.snapshot().groups)
})

test('the command service exposes a mutation only after persistence succeeds', async () => {
  const state: { stored: PrototypeLedger | null } = { stored: null }
  let rejectSave = false
  const service = new PrototypeCommandService({
    load: async () => state.stored,
    save: async (ledger) => {
      if (rejectSave) throw new Error('injected persistence failure')
      state.stored = structuredClone(ledger)
    }
  })
  await service.initialize(createInitialLedger('project-1', 'Prototype project'))
  rejectSave = true

  await expect(service.execute({ type: 'create-group', name: 'Unsaved' })).rejects.toThrow(
    'injected persistence failure'
  )
  expect(service.snapshot().groups).toEqual([])
  expect(state.stored?.groups).toEqual([])
})
