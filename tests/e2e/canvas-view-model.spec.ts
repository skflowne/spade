import { expect, test } from '@playwright/test'
import { branchMoves, canvasView } from '../../src/renderer/src/canvas/viewModel'
import { focusViewport } from '../../src/renderer/src/canvas/viewportMath'
import { createBuiltinEntityRegistry } from '../../src/shared/builtinEntities'
import {
  DOMAIN_RECORD_VERSION,
  createEmptyCanvas,
  type Canvas,
  type CanvasEdge,
  type CanvasNode
} from '../../src/shared/domain'

const entities = createBuiltinEntityRegistry()

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
    config: { body: '' },
    resourceRef: null,
    createdAt: '2026-11-21T00:00:00.000Z',
    updatedAt: '2026-11-21T00:00:00.000Z',
    ...overrides
  }
}

function edge(from: string, to: string, relation: CanvasEdge['relation'] = 'child'): CanvasEdge {
  return {
    version: DOMAIN_RECORD_VERSION,
    id: `${from}-${relation}-${to}`,
    fromNodeId: from,
    toNodeId: to,
    relation,
    createdAt: '2026-11-21T00:00:00.000Z'
  }
}

function canvasOf(nodes: CanvasNode[], edges: CanvasEdge[] = []): Canvas {
  return { ...createEmptyCanvas('project'), nodes, edges }
}

test.describe('canvas view', () => {
  test('draws every visible node at its presented size and leaves hidden nodes out', () => {
    const canvas = canvasOf(
      [
        node('root', { branchCollapsed: true }),
        node('child'),
        node('grandchild'),
        node('sized', { size: { width: 500, height: 300 }, position: { x: 40, y: 900 } }),
        node('collapsed', { collapsed: true, size: { width: 700, height: 700 } }),
        node('archived', { archived: true }),
        node('mystery', { entityType: 'not-registered' })
      ],
      [edge('root', 'child'), edge('child', 'grandchild')]
    )

    const view = canvasView(canvas, entities)

    expect(view.nodes.map((entry) => entry.id)).toEqual(['root', 'sized', 'collapsed', 'mystery'])
    const byId = new Map(view.nodes.map((entry) => [entry.id, entry]))
    expect(byId.get('root')).toMatchObject({ size: { width: 320, height: 200 }, hiddenDescendantCount: 2, childCount: 1 })
    expect(byId.get('sized')).toMatchObject({ position: { x: 40, y: 900 }, size: { width: 500, height: 300 } })
    expect(byId.get('collapsed')).toMatchObject({ size: { width: 320, height: 96 }, hiddenDescendantCount: 0 })
    expect(byId.get('mystery')).toMatchObject({ size: { width: 320, height: 200 } })
  })

  test('counts no hidden descendants for an expanded branch, and skips archived descendants in the count', () => {
    const canvas = canvasOf(
      [node('root'), node('a'), node('b', { archived: true }), node('folded', { branchCollapsed: true }), node('c')],
      [edge('root', 'a'), edge('root', 'b'), edge('root', 'folded'), edge('folded', 'c')]
    )
    const byId = new Map(canvasView(canvas, entities).nodes.map((entry) => [entry.id, entry]))
    expect(byId.get('root')).toMatchObject({ hiddenDescendantCount: 0, childCount: 3 })
    expect(byId.get('folded')).toMatchObject({ hiddenDescendantCount: 1, childCount: 1 })
  })

  test('draws lineage and reference edges distinctly and never to a hidden endpoint', () => {
    const canvas = canvasOf(
      [node('root'), node('child'), node('gone', { archived: true }), node('other')],
      [edge('root', 'child'), edge('root', 'gone'), edge('child', 'other', 'references'), edge('gone', 'other', 'references')]
    )

    expect(canvasView(canvas, entities).edges).toEqual([
      { id: 'root-child-child', source: 'root', target: 'child', relation: 'child' },
      { id: 'child-references-other', source: 'child', target: 'other', relation: 'references' }
    ])
  })
})

test.describe('branch moves', () => {
  test('moves the node and every descendant by the same offset', () => {
    const canvas = canvasOf(
      [
        node('root', { position: { x: 0, y: 0 } }),
        node('child', { position: { x: 480, y: 0 } }),
        node('hidden', { position: { x: 960, y: 40 }, archived: true }),
        node('unrelated', { position: { x: 0, y: 600 } })
      ],
      [edge('root', 'child'), edge('child', 'hidden')]
    )

    expect(branchMoves(canvas, 'child', { x: 500, y: -30 })).toEqual([
      { nodeId: 'child', position: { x: 500, y: -30 } },
      { nodeId: 'hidden', position: { x: 980, y: 10 } }
    ])
  })
})

test.describe('focus viewport', () => {
  const screen = { width: 1000, height: 800 }
  const limits = { minZoom: 0.1, maxZoom: 2 }

  test('centers a node that fits at 100% zoom', () => {
    const viewport = focusViewport({ x: 100, y: 200, width: 320, height: 200 }, screen, 'readable', limits)
    expect(viewport.zoom).toBe(1)
    // The node's center lands on the screen's center.
    expect(260 * viewport.zoom + viewport.x).toBeCloseTo(500)
    expect(300 * viewport.zoom + viewport.y).toBeCloseTo(400)
  })

  test('zooms out just enough for a node larger than the screen to fit', () => {
    const viewport = focusViewport({ x: 0, y: 0, width: 960, height: 1500 }, screen, 'readable', limits)
    expect(viewport.zoom).toBeLessThan(1)
    expect(1500 * viewport.zoom).toBeLessThanOrEqual(800)
    expect(1500 * viewport.zoom).toBeGreaterThan(700)
  })

  test('fits a small node to the screen and scales a node to the full screen height', () => {
    const rect = { x: 0, y: 0, width: 640, height: 200 }
    const fit = focusViewport(rect, screen, 'fit', limits)
    expect(640 * fit.zoom).toBeLessThanOrEqual(1000)
    expect(640 * fit.zoom).toBeGreaterThan(850)

    const fullHeight = focusViewport({ x: 0, y: 0, width: 2000, height: 400 }, screen, 'full-height', limits)
    expect(400 * fullHeight.zoom).toBeGreaterThan(700)
    expect(400 * fullHeight.zoom).toBeLessThanOrEqual(800)
    // Its width overflows the screen rather than shrinking the node.
    expect(2000 * fullHeight.zoom).toBeGreaterThan(1000)
    expect(1000 * fullHeight.zoom + fullHeight.x).toBeCloseTo(500)
  })

  test('stays within the zoom limits', () => {
    expect(focusViewport({ x: 0, y: 0, width: 10, height: 10 }, screen, 'fit', limits).zoom).toBe(2)
    expect(focusViewport({ x: 0, y: 0, width: 100_000, height: 100_000 }, screen, 'readable', limits).zoom).toBe(0.1)
  })
})
