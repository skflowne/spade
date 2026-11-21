import { expect, test } from '@playwright/test'
import { createBuiltinEntityRegistry, noteEntity } from '../../src/shared/builtinEntities'
import {
  DOMAIN_RECORD_VERSION,
  createEmptyCanvas,
  type Canvas,
  type CanvasEdge,
  type CanvasNode,
  type Point
} from '../../src/shared/domain'
import {
  PARENT_CHILD_SPACING,
  SIBLING_SPACING,
  TREE_SPACING,
  UNKNOWN_ENTITY_SIZE,
  placeNode,
  presentedSize,
  reservedSize
} from '../../src/shared/layout'

const at = '2026-01-01T00:00:00.000Z'
const entities = createBuiltinEntityRegistry()
// Built-in sizes, restated so expected coordinates are computed by hand rather than read from the code.
const NOTE = { width: 320, height: 200 }
const AGENT = { width: 640, height: 720 }

type Spec = { id: string; at: Point; type?: string; parent?: string } & Pick<
  Partial<CanvasNode>,
  'collapsed' | 'branchCollapsed' | 'archived' | 'size'
>

function canvasOf(...specs: Spec[]): Canvas {
  const nodes: CanvasNode[] = specs.map(({ id, at: position, type, collapsed, branchCollapsed, archived, size }) => ({
    version: DOMAIN_RECORD_VERSION,
    id,
    entityType: type ?? 'note',
    entityVersion: 1,
    title: id,
    position,
    ...(size ? { size } : {}),
    collapsed: collapsed ?? false,
    branchCollapsed: branchCollapsed ?? false,
    archived: archived ?? false,
    projectId: 'project',
    groupId: null,
    workspaceId: null,
    config: {},
    resourceRef: null,
    createdAt: at,
    updatedAt: at
  }))
  const edges: CanvasEdge[] = specs
    .filter((spec) => spec.parent)
    .map((spec) => ({
      version: DOMAIN_RECORD_VERSION,
      id: `edge-${spec.id}`,
      fromNodeId: spec.parent!,
      toNodeId: spec.id,
      relation: 'child',
      origin: 'spawned',
      createdAt: at
    }))
  return { ...createEmptyCanvas('project'), nodes, edges }
}

test('spacing constants match the plan', () => {
  expect(SIBLING_SPACING).toBe(96)
  expect(PARENT_CHILD_SPACING).toBe(160)
  expect(TREE_SPACING).toBe(240)
})

test('reserved size is the expanded footprint; presented size follows the collapsed state', () => {
  const collapsed = { collapsed: true, size: undefined }
  expect(reservedSize(collapsed, noteEntity)).toEqual({ width: 320, height: 200 })
  expect(presentedSize(collapsed, noteEntity)).toEqual({ width: 320, height: 96 })

  const resized = { collapsed: false, size: { width: 500, height: 300 } }
  expect(reservedSize(resized, noteEntity)).toEqual({ width: 500, height: 300 })
  expect(presentedSize(resized, noteEntity)).toEqual({ width: 500, height: 300 })
  expect(presentedSize({ ...resized, collapsed: true }, noteEntity)).toEqual({ width: 320, height: 96 })

  expect(reservedSize({ size: undefined }, null)).toEqual(UNKNOWN_ENTITY_SIZE)
})

test('the first root of an empty canvas goes to the origin', () => {
  expect(placeNode(createEmptyCanvas('project'), entities, { parentId: null, size: NOTE })).toEqual({ x: 0, y: 0 })
})

test('a new root goes below all existing content, left-aligned, one tree spacing down', () => {
  const canvas = canvasOf(
    { id: 'a', at: { x: 100, y: 50 } },
    { id: 'b', at: { x: 580, y: 50 }, parent: 'a', type: 'agent' },
    { id: 'z', at: { x: 40, y: 900 }, archived: true }
  )
  // Lowest bottom: agent b at 50 + 720 = 770. Leftmost: a at 100. Archived z reserves nothing.
  expect(placeNode(canvas, entities, { parentId: null, size: NOTE })).toEqual({ x: 100, y: 770 + 240 })
})

test('a first child goes to the right of its parent, top-aligned', () => {
  const canvas = canvasOf({ id: 'a', at: { x: 0, y: 0 } })
  expect(placeNode(canvas, entities, { parentId: 'a', size: NOTE })).toEqual({ x: 320 + 160, y: 0 })
})

test('siblings stack downward in creation order', () => {
  const canvas = canvasOf(
    { id: 'a', at: { x: 0, y: 0 }, type: 'agent' },
    { id: 'b', at: { x: 800, y: 0 }, parent: 'a' },
    { id: 'c', at: { x: 800, y: 296 }, parent: 'a' }
  )
  // Agent parent is 640 wide; the column starts at 640 + 160. c ends at 296 + 200.
  expect(placeNode(canvas, entities, { parentId: 'a', size: NOTE })).toEqual({ x: 800, y: 296 + 200 + 96 })
})

test('placement reserves the extent of earlier siblings subtrees', () => {
  const canvas = canvasOf(
    { id: 'a', at: { x: 0, y: 0 } },
    { id: 'b', at: { x: 480, y: 0 }, parent: 'a' },
    { id: 'c', at: { x: 960, y: 0 }, parent: 'b', type: 'agent' }
  )
  // b's subtree ends at the bottom of agent c (720), not at b's own bottom (200).
  expect(placeNode(canvas, entities, { parentId: 'a', size: NOTE })).toEqual({ x: 480, y: 720 + 96 })
})

test('collapsed and branch-hidden nodes reserve their expanded footprint', () => {
  const canvas = canvasOf(
    { id: 'a', at: { x: 0, y: 0 } },
    { id: 'b', at: { x: 480, y: 0 }, parent: 'a', collapsed: true, branchCollapsed: true },
    { id: 'c', at: { x: 960, y: 0 }, parent: 'b', size: { width: 320, height: 500 } }
  )
  // b presents 96 tall and hides c, yet the next sibling still clears c's 500-tall footprint.
  expect(placeNode(canvas, entities, { parentId: 'a', size: NOTE })).toEqual({ x: 480, y: 500 + 96 })
})

test('archived nodes reserve nothing', () => {
  const canvas = canvasOf(
    { id: 'a', at: { x: 0, y: 0 } },
    { id: 'b', at: { x: 480, y: 0 }, parent: 'a', archived: true }
  )
  expect(placeNode(canvas, entities, { parentId: 'a', size: NOTE })).toEqual({ x: 480, y: 0 })
})

test('a taken slot moves down past a node of the same tree, keeping sibling spacing', () => {
  // The user moved t (a cousin in the same tree) to sit just under the natural slot of a's first child.
  const canvas = canvasOf(
    { id: 'r', at: { x: 0, y: 0 } },
    { id: 'a', at: { x: 480, y: 0 }, parent: 'r' },
    { id: 's', at: { x: 480, y: 1000 }, parent: 'r' },
    { id: 't', at: { x: 960, y: 250 }, parent: 's' }
  )
  // Natural slot: (480 + 320 + 160, 0). t sits at y 250 < 0 + 200 + 96.
  expect(placeNode(canvas, entities, { parentId: 'a', size: NOTE })).toEqual({ x: 960, y: 250 + 200 + 96 })
})

test('a taken slot moves down past another tree, keeping tree spacing', () => {
  const canvas = canvasOf({ id: 'a', at: { x: 0, y: 0 } }, { id: 'other', at: { x: 480, y: 300 } })
  // Natural slot (480, 0) is 100 above another tree's root; it needs 240 of clearance, so it drops below it.
  expect(placeNode(canvas, entities, { parentId: 'a', size: NOTE })).toEqual({ x: 480, y: 300 + 200 + 240 })
})

test('another tree beyond tree spacing does not displace the natural slot', () => {
  const canvas = canvasOf({ id: 'a', at: { x: 0, y: 0 } }, { id: 'other', at: { x: 480, y: 200 + 240 } })
  expect(placeNode(canvas, entities, { parentId: 'a', size: NOTE })).toEqual({ x: 480, y: 0 })
})

test('skips several stacked obstacles to the nearest free slot below', () => {
  const canvas = canvasOf(
    { id: 'a', at: { x: 0, y: 0 } },
    { id: 'o1', at: { x: 480, y: 100 } },
    { id: 'o2', at: { x: 900, y: 500 }, type: 'agent' },
    { id: 'far', at: { x: 480, y: 5000 } }
  )
  // o1 pushes to 100+200+240 = 540, where o2 (spans x 900..1540, y 500..1220) collides; next is 1220+240.
  expect(placeNode(canvas, entities, { parentId: 'a', size: { width: 500, height: 200 } })).toEqual({
    x: 480,
    y: 1220 + 240
  })
})

test('nodes of unregistered entity types still reserve space', () => {
  const canvas = canvasOf({ id: 'a', at: { x: 0, y: 0 }, type: 'legacy' })
  expect(placeNode(canvas, entities, { parentId: 'a', size: NOTE })).toEqual({
    x: UNKNOWN_ENTITY_SIZE.width + 160,
    y: 0
  })
  expect(placeNode(canvas, entities, { parentId: null, size: AGENT })).toEqual({
    x: 0,
    y: UNKNOWN_ENTITY_SIZE.height + 240
  })
})
