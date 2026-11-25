import { expect, test } from '@playwright/test'
import { shareCanvas, shareRecords } from '../../src/renderer/src/store/sharing'
import { SpadeStore } from '../../src/renderer/src/store/store'
import type { AgentRuntime } from '../../src/shared/agents'
import type { AppState, SpadeHostBridge } from '../../src/shared/ipc'
import {
  DOMAIN_RECORD_VERSION,
  createEmptyCanvas,
  type Canvas,
  type CanvasActivity,
  type CanvasEdge,
  type CanvasNode
} from '../../src/shared/domain'

function node(id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    version: DOMAIN_RECORD_VERSION,
    id,
    entityType: 'note',
    entityVersion: 1,
    title: id,
    position: { x: 0, y: 0 },
    collapsed: false,
    branchCollapsed: false,
    archived: false,
    projectId: 'project',
    groupId: null,
    workspaceId: null,
    config: { body: `${id} text`, nested: { list: [1, 2, { deep: true }] } },
    resourceRef: null,
    createdAt: '2026-11-21T00:00:00.000Z',
    updatedAt: '2026-11-21T00:00:00.000Z',
    ...overrides
  }
}

function edge(from: string, to: string): CanvasEdge {
  return {
    version: DOMAIN_RECORD_VERSION,
    id: `${from}-${to}`,
    fromNodeId: from,
    toNodeId: to,
    relation: 'child',
    createdAt: '2026-11-21T00:00:00.000Z'
  }
}

function activity(id: string): CanvasActivity {
  return { id, at: '2026-11-21T00:00:00.000Z', actor: { kind: 'user' }, command: 'moveNodes', summary: 'Moved', nodeIds: ['a'] }
}

function canvasOf(overrides: Partial<Canvas> = {}): Canvas {
  return {
    ...createEmptyCanvas('project'),
    nodes: [node('a'), node('b')],
    edges: [edge('a', 'b')],
    activity: [activity('1')],
    viewport: { x: 0, y: 0, zoom: 1 },
    ...overrides
  }
}

// What a canvas push delivers: a structured clone, equal in value and sharing no object with the previous one.
const pushed = (canvas: Canvas): Canvas => structuredClone(canvas)

test.describe('canvas pushes', () => {
  test('keep the previous canvas when nothing changed', () => {
    const previous = canvasOf()
    expect(shareCanvas(previous, pushed(previous))).toBe(previous)
  })

  test('keep every node, edge and list when only the viewport changed', () => {
    const previous = canvasOf()
    const next = shareCanvas(previous, pushed({ ...previous, viewport: { x: 40, y: -12, zoom: 0.8 } }))
    expect(next).not.toBe(previous)
    expect(next.viewport).toEqual({ x: 40, y: -12, zoom: 0.8 })
    expect(next.nodes).toBe(previous.nodes)
    expect(next.edges).toBe(previous.edges)
    expect(next.workspaces).toBe(previous.workspaces)
    expect(next.activity).toBe(previous.activity)
  })

  test('replace only the node that changed, deep inside its config included', () => {
    const previous = canvasOf()
    const changed = pushed(previous)
    ;(changed.nodes[1].config as { nested: { list: unknown[] } }).nested.list[2] = { deep: false }
    changed.activity.push(activity('2'))
    const next = shareCanvas(previous, changed)
    expect(next.nodes).not.toBe(previous.nodes)
    expect(next.nodes[0]).toBe(previous.nodes[0])
    expect(next.nodes[1]).not.toBe(previous.nodes[1])
    expect(next.nodes[1]).toEqual(changed.nodes[1])
    expect(next.edges).toBe(previous.edges)
    expect(next.activity).not.toBe(previous.activity)
    expect(next.activity[0]).toBe(previous.activity[0])
    expect(next.activity[1]).toEqual(activity('2'))
  })

  test('take new records, removals and reorderings as they come', () => {
    const previous = canvasOf()
    const reordered = pushed({ ...previous, nodes: [previous.nodes[1], previous.nodes[0]] })
    const next = shareCanvas(previous, reordered)
    expect(next.nodes).not.toBe(previous.nodes)
    expect(next.nodes.map((entry) => entry.id)).toEqual(['b', 'a'])
    expect(next.nodes[0]).toBe(previous.nodes[1])

    const removed = shareCanvas(previous, pushed({ ...previous, nodes: [previous.nodes[0]] }))
    expect(removed.nodes).toEqual([previous.nodes[0]])
    expect(removed.nodes[0]).toBe(previous.nodes[0])

    const added = shareCanvas(previous, pushed({ ...previous, nodes: [...previous.nodes, node('c')] }))
    expect(added.nodes.slice(0, 2)).toEqual(previous.nodes)
    expect(added.nodes[0]).toBe(previous.nodes[0])
    expect(added.nodes[2]).toEqual(node('c'))
  })

  test('treat a removed field or an array turned object as a change', () => {
    const previous = canvasOf({ nodes: [node('a', { size: { width: 10, height: 10 } })] })
    const withoutSize = pushed(previous)
    delete withoutSize.nodes[0].size
    expect(shareCanvas(previous, withoutSize).nodes[0]).not.toBe(previous.nodes[0])

    const arrayConfig = canvasOf({ nodes: [node('a', { config: { list: [] } })] })
    const objectConfig = pushed(arrayConfig)
    objectConfig.nodes[0].config = { list: {} }
    expect(shareCanvas(arrayConfig, objectConfig).nodes[0]).not.toBe(arrayConfig.nodes[0])
  })

  test('start from the pushed canvas when there is no previous one', () => {
    const canvas = canvasOf()
    expect(shareCanvas(undefined, canvas)).toBe(canvas)
  })
})

test.describe('record lists', () => {
  test('reuse equal records by id and the whole list when every entry is reused in order', () => {
    const previous = [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }]
    expect(shareRecords(previous, structuredClone(previous))).toBe(previous)
    const renamed = shareRecords(previous, [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Deux' }])
    expect(renamed[0]).toBe(previous[0])
    expect(renamed[1]).toEqual({ id: 'p2', name: 'Deux' })
  })
})

test.describe('agent runtimes', () => {
  // The bridge as far as the store's pushes go; reads answer with nothing new.
  function fakeHost() {
    const listeners: { state?: (app: AppState) => void; canvas?: (canvas: Canvas) => void; runtime?: (runtime: AgentRuntime) => void } = {}
    const host = {
      app: { onState: (listener: (app: AppState) => void) => ((listeners.state = listener), () => {}), getState: () => new Promise(() => {}) },
      canvas: { onChanged: (listener: (canvas: Canvas) => void) => ((listeners.canvas = listener), () => {}), get: () => new Promise(() => {}) },
      agents: { onRuntime: (listener: (runtime: AgentRuntime) => void) => ((listeners.runtime = listener), () => {}), getRuntimes: async () => [] }
    }
    return { host: host as unknown as SpadeHostBridge, listeners }
  }

  function runtime(projectId: string, nodeId: string): AgentRuntime {
    return {
      projectId,
      nodeId,
      agentId: `agent-${nodeId}`,
      resourceState: 'live',
      parentAgentId: null,
      provider: 'claude',
      model: null,
      mode: null,
      title: null,
      status: 'idle',
      activity: 'idle',
      cwd: null,
      pendingPermissions: [],
      providerSubagents: [],
      children: [],
      lastError: null,
      updatedAt: '2026-11-21T00:00:00.000Z'
    }
  }

  test('the canvas decides which runtimes exist: a node removed from it drops its runtime', () => {
    const { host, listeners } = fakeHost()
    const store = new SpadeStore(host)
    store.start()
    const project = (id: string) => ({ version: DOMAIN_RECORD_VERSION, id, name: id, rootPath: `/work/${id}`, createdAt: '2026-11-21T00:00:00.000Z' })
    listeners.state!({
      projects: [project('project'), project('other')],
      selectedProjectId: null,
      settings: { agentDefaults: null, conversationExpansion: { toolCall: true, diff: true, html: true, thinking: true, read: false }, paseoUrl: null },
      paseo: { state: 'connected', url: 'ws://x/ws', error: null },
      appVersion: '0.0.0',
      problems: []
    } as AppState)
    listeners.canvas!(canvasOf())
    for (const entry of [runtime('project', 'a'), runtime('project', 'b'), runtime('other', 'elsewhere')]) listeners.runtime!(entry)

    // "Collapse into owner" removes b's node; the agent service stops reporting it.
    listeners.canvas!(pushed(canvasOf({ nodes: [node('a')], edges: [] })))

    expect([...store.getSnapshot().runtimes.keys()].sort()).toEqual(['a', 'elsewhere'])
  })
})
