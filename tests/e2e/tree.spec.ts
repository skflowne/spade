import { expect, test } from '@playwright/test'
import {
  DOMAIN_RECORD_VERSION,
  createEmptyCanvas,
  type Canvas,
  type CanvasEdge,
  type CanvasNode
} from '../../src/shared/domain'
import { indexTree } from '../../src/shared/tree'

const at = '2026-01-01T00:00:00.000Z'

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
    createdAt: at,
    updatedAt: at,
    ...overrides
  }
}

function edge(fromNodeId: string, toNodeId: string, relation: CanvasEdge['relation'] = 'child'): CanvasEdge {
  return {
    version: DOMAIN_RECORD_VERSION,
    id: `${relation}:${fromNodeId}->${toNodeId}`,
    fromNodeId,
    toNodeId,
    relation,
    origin: relation === 'child' ? 'spawned' : undefined,
    createdAt: at
  }
}

// a ─┬─ b ─── d
//    └─ c
// e ─── f      (plus a references edge c → e that must never count as structure)
function forest(nodeOverrides: Record<string, Partial<CanvasNode>> = {}): Canvas {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  return {
    ...createEmptyCanvas('project'),
    nodes: ids.map((id) => node(id, nodeOverrides[id])),
    // Edge order differs from node creation order on purpose.
    edges: [edge('a', 'c'), edge('b', 'd'), edge('e', 'f'), edge('a', 'b'), edge('c', 'e', 'references')]
  }
}

test('reads parents, children in node creation order, and roots from child edges only', () => {
  const tree = indexTree(forest())

  expect(tree.parentOf('b')).toBe('a')
  expect(tree.parentOf('d')).toBe('b')
  expect(tree.parentOf('a')).toBeNull()
  expect(tree.parentOf('e')).toBeNull()
  expect(tree.parentEdgeOf('c')?.id).toBe('child:a->c')
  expect(tree.parentEdgeOf('a')).toBeNull()
  expect(tree.childrenOf('a')).toEqual(['b', 'c'])
  expect(tree.childrenOf('c')).toEqual([])
  expect(tree.roots()).toEqual(['a', 'e'])
})

test('derives descendants, branches, and the root of any node', () => {
  const tree = indexTree(forest())

  expect(tree.descendantsOf('a')).toEqual(['b', 'd', 'c'])
  expect(tree.descendantsOf('d')).toEqual([])
  expect(tree.branchOf('b')).toEqual(['b', 'd'])
  expect(tree.rootOf('d')).toBe('a')
  expect(tree.rootOf('f')).toBe('e')
  expect(tree.rootOf('a')).toBe('a')
})

test('detects reparenting that would create a cycle', () => {
  const tree = indexTree(forest())

  expect(tree.wouldCreateCycle('a', 'a')).toBe(true)
  expect(tree.wouldCreateCycle('a', 'd')).toBe(true)
  expect(tree.wouldCreateCycle('b', 'd')).toBe(true)
  expect(tree.wouldCreateCycle('b', 'c')).toBe(false)
  expect(tree.wouldCreateCycle('e', 'd')).toBe(false)
  expect(tree.wouldCreateCycle('d', null)).toBe(false)
})

test('counts the descendants a collapsed branch hides, ignoring archived ones', () => {
  const tree = indexTree(forest({ d: { archived: true } }))

  expect(tree.descendantCount('a')).toBe(2)
  expect(tree.descendantCount('b')).toBe(0)
  expect(tree.descendantCount('e')).toBe(1)
})

test('hides archived nodes and every descendant of a branch-collapsed node', () => {
  expect(indexTree(forest()).hiddenNodeIds()).toEqual(new Set())

  const hidden = indexTree(forest({ b: { branchCollapsed: true }, f: { archived: true } })).hiddenNodeIds()
  expect(hidden).toEqual(new Set(['d', 'f']))

  // The collapsed node itself stays visible; collapsing an ancestor hides the whole subtree.
  const rootCollapsed = indexTree(forest({ a: { branchCollapsed: true } })).hiddenNodeIds()
  expect(rootCollapsed).toEqual(new Set(['b', 'c', 'd']))
})

test('an archived parent does not hide its children', () => {
  const hidden = indexTree(forest({ b: { archived: true } })).hiddenNodeIds()
  expect(hidden).toEqual(new Set(['b']))
})

test('ignores edges whose endpoints are not on the canvas', () => {
  const canvas = forest()
  const tree = indexTree({ ...canvas, edges: [...canvas.edges, edge('ghost', 'a'), edge('a', 'ghost')] })

  expect(tree.parentOf('a')).toBeNull()
  expect(tree.childrenOf('a')).toEqual(['b', 'c'])
  expect(tree.rootOf('a')).toBe('a')
})
