import { expect, test } from '@playwright/test'
import {
  applyPrototypeCommand,
  createInitialLedger,
  resolveGroup
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/commands'
import { projectActivitySidebar, projectGroupHull } from '../../prototypes/paseo-issue-to-pr-bridge/shared/projection'
import type {
  ExternalResourceReference,
  Group,
  PrototypeLedger,
  WorkItem
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/model'

const agentRef: ExternalResourceReference = {
  provider: 'placeholder',
  kind: 'agent',
  id: 'agent-external-1',
  revision: 'revision-7'
}

function apply(ledger: PrototypeLedger, command: Parameters<typeof applyPrototypeCommand>[1]): PrototypeLedger {
  return applyPrototypeCommand(ledger, command).ledger
}

test('resolves groups by stable ID or one unique case-insensitive name', () => {
  let ledger = createInitialLedger('project-1', 'Prototype project')
  ledger = apply(ledger, { type: 'create-group', name: 'Research' })
  ledger = apply(ledger, { type: 'create-work-item', name: 'Delivery', task: 'Ship the prototype' })

  expect(resolveGroup(ledger, 'group-1')).toMatchObject({ id: 'group-1', name: 'Research' })
  expect(resolveGroup(ledger, 'delivery')).toMatchObject({ id: 'work-item-2', name: 'Delivery' })
  expect(() => resolveGroup(ledger, 'missing')).toThrow('No group matches “missing”.')
})

test('rejects ambiguous names and requires the caller to use a stable ID', () => {
  let ledger = createInitialLedger('project-1', 'Prototype project')
  ledger = apply(ledger, { type: 'create-group', name: 'Shared' })
  ledger = apply(ledger, { type: 'create-group', name: 'shared' })

  expect(() => resolveGroup(ledger, 'SHARED')).toThrow(
    'More than one group is named “SHARED”. Use a stable group ID.'
  )
  expect(resolveGroup(ledger, 'group-2')).toMatchObject({ id: 'group-2', name: 'shared' })
})

test('ordinary Group containment stays visual while WorkItem containment adds semantic membership', () => {
  let ledger = createInitialLedger('project-1', 'Prototype project')
  ledger = apply(ledger, { type: 'create-group', name: 'Visual cluster' })
  ledger = apply(ledger, {
    type: 'create-work-item',
    name: 'Issue 17',
    task: 'Build the generic shell',
    sourceRef: { provider: 'placeholder', kind: 'task', id: 'task-17', revision: null }
  })
  ledger = apply(ledger, {
    type: 'spawn-placeholder',
    targetGroup: 'Visual cluster',
    nodeKind: 'agent',
    title: 'Visual-only agent',
    resourceRef: agentRef
  })
  ledger = apply(ledger, {
    type: 'attach-placeholder',
    targetGroup: 'work-item-2',
    nodeKind: 'workspace',
    title: 'Issue workspace',
    resourceRef: { provider: 'placeholder', kind: 'workspace', id: 'workspace-external-1', revision: null }
  })

  expect(ledger.nodes[0]).toMatchObject({ groupId: 'group-1', workItemId: null })
  expect(ledger.nodes[1]).toMatchObject({ groupId: 'work-item-2', workItemId: 'work-item-2' })
  expect(ledger.nodes[0].resourceRef).toEqual(agentRef)
})

test('moving a WorkItem member into an ordinary Group preserves semantic membership', () => {
  let ledger = createInitialLedger('project-1', 'Prototype project')
  ledger = apply(ledger, { type: 'create-work-item', name: 'Issue 17', task: 'Build shell' })
  ledger = apply(ledger, { type: 'create-group', name: 'Review cluster' })
  ledger = apply(ledger, {
    type: 'attach-placeholder',
    targetGroup: 'Issue 17',
    nodeKind: 'agent',
    title: 'Root agent',
    resourceRef: agentRef
  })
  ledger = apply(ledger, {
    type: 'attach-placeholder',
    targetGroup: 'Review cluster',
    nodeKind: 'agent',
    title: 'Root agent',
    resourceRef: agentRef
  })

  expect(ledger.nodes[0]).toMatchObject({ groupId: 'group-2', workItemId: 'work-item-1' })
})

test('placeholder reconciliation and provenance connections are idempotent', () => {
  let ledger = createInitialLedger('project-1', 'Prototype project')
  ledger = apply(ledger, { type: 'create-work-item', name: 'Issue 17', task: 'Build shell' })

  const attach = {
    type: 'attach-placeholder' as const,
    targetGroup: 'Issue 17',
    nodeKind: 'agent' as const,
    title: 'Root agent',
    resourceRef: agentRef
  }
  ledger = apply(ledger, attach)
  ledger = apply(ledger, attach)
  expect(ledger.nodes).toHaveLength(1)
  expect(ledger.nodes[0].resourceRef).toEqual(agentRef)

  ledger = apply(ledger, {
    type: 'spawn-placeholder',
    targetGroup: 'Issue 17',
    nodeKind: 'workspace',
    title: 'Workspace',
    resourceRef: { provider: 'placeholder', kind: 'workspace', id: 'workspace-external-1', revision: null }
  })
  ledger = apply(ledger, {
    type: 'connect-nodes',
    fromNodeId: 'node-2',
    toNodeId: 'node-3',
    relation: 'connected'
  })
  ledger = apply(ledger, {
    type: 'connect-nodes',
    fromNodeId: 'node-2',
    toNodeId: 'node-3',
    relation: 'connected'
  })

  expect(ledger.edges).toHaveLength(1)
})

test('placeholder placement wraps before neighboring Group hulls overlap', () => {
  let ledger = createInitialLedger('project-1', 'Prototype project')
  ledger = apply(ledger, { type: 'create-work-item', name: 'Issue 17', task: 'Build shell' })
  ledger = apply(ledger, { type: 'create-group', name: 'Neighbor' })
  for (let index = 1; index <= 3; index += 1) {
    ledger = apply(ledger, {
      type: 'spawn-placeholder',
      targetGroup: 'Issue 17',
      nodeKind: 'agent',
      title: `Agent ${index}`,
      resourceRef: { provider: 'placeholder', kind: 'agent', id: `agent-${index}`, revision: null }
    })
  }

  const workItemHull = projectGroupHull(ledger.groups[0], ledger.nodes)
  const neighborHull = projectGroupHull(ledger.groups[1], ledger.nodes)
  expect(workItemHull.geometry.position.x + workItemHull.geometry.size.width).toBeLessThanOrEqual(
    neighborHull.geometry.position.x
  )
})

test('WorkItem and ordinary Group use the same hull projection and only WorkItems reach the sidebar', () => {
  const group: Group = {
    id: 'group-1',
    kind: 'group',
    projectId: 'project-1',
    name: 'Ordinary',
    position: { x: 100, y: 120 }
  }
  const workItem: WorkItem = {
    ...group,
    id: 'work-item-1',
    kind: 'work-item',
    name: 'Issue 17',
    task: 'Build shell',
    sourceRef: null,
    status: 'active'
  }
  const nodes = [
    {
      id: 'node-1',
      projectId: 'project-1',
      groupId: 'group-1',
      workItemId: null,
      kind: 'agent' as const,
      title: 'Agent',
      position: { x: 140, y: 180 },
      resourceRef: agentRef,
      paseo: null
    }
  ]
  const workItemNodes = nodes.map((node) => ({ ...node, groupId: workItem.id, workItemId: workItem.id }))

  expect(projectGroupHull(group, nodes).geometry).toEqual(projectGroupHull(workItem, workItemNodes).geometry)
  expect(projectActivitySidebar([group, workItem])).toEqual([
    { id: 'work-item-1', title: 'Issue 17', status: 'active' }
  ])
})
