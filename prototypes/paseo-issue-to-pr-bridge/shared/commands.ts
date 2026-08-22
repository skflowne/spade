import {
  createInitialPaseoState,
  PROTOTYPE_LEDGER_VERSION,
  type ExternalResourceReference,
  type PlaceholderKind,
  sameResourceIdentity,
  type PrototypeGroup,
  type PrototypeLedger,
  type ProvenanceRelation,
  type WorkItemStatus
} from './model'

export type PrototypeCommand =
  | { type: 'create-group'; name: string }
  | {
      type: 'create-work-item'
      name: string
      task: string
      sourceRef?: ExternalResourceReference
      status?: WorkItemStatus
    }
  | {
      type: 'spawn-placeholder' | 'attach-placeholder'
      targetGroup: string
      nodeKind: PlaceholderKind
      title: string
      resourceRef: ExternalResourceReference
    }
  | {
      type: 'connect-nodes'
      fromNodeId: string
      toNodeId: string
      relation: ProvenanceRelation
    }
  | { type: 'set-work-item-status'; workItemId: string; status: WorkItemStatus }
  | { type: 'select-project-checkout'; targetGroup: string; cwd: string }
  | { type: 'create-workspace'; targetGroup: string; cwd: string; title?: string }
  | { type: 'attach-workspace'; targetGroup: string; workspaceId: string }
  | {
      type: 'spawn-agent'
      targetGroup: string
      workspaceId?: string
      cwd: string
      provider: string
      model: string
      prompt: string
      title?: string
    }
  | { type: 'attach-agent'; targetGroup: string; agentId: string }
  | { type: 'refresh-paseo'; workItemId: string }

export type PaseoCommand = Extract<
  PrototypeCommand,
  {
    type:
      | 'select-project-checkout'
      | 'create-workspace'
      | 'attach-workspace'
      | 'spawn-agent'
      | 'attach-agent'
      | 'refresh-paseo'
  }
>

export function isPaseoCommand(command: PrototypeCommand): command is PaseoCommand {
  return [
    'select-project-checkout',
    'create-workspace',
    'attach-workspace',
    'spawn-agent',
    'attach-agent',
    'refresh-paseo'
  ].includes(command.type)
}

export type CommandResult = {
  ledger: PrototypeLedger
  affectedId: string
}

export function createInitialLedger(projectId: string, projectName: string): PrototypeLedger {
  return {
    version: PROTOTYPE_LEDGER_VERSION,
    nextSequence: 1,
    project: { id: requiredText(projectId, 'Project ID'), name: requiredText(projectName, 'Project name') },
    groups: [],
    nodes: [],
    edges: [],
    paseo: createInitialPaseoState()
  }
}

export function resolveGroup(ledger: PrototypeLedger, reference: string): PrototypeGroup {
  const exactId = ledger.groups.find(({ id }) => id === reference)
  if (exactId) return exactId

  const normalized = reference.trim().toLowerCase()
  const nameMatches = ledger.groups.filter(({ name }) => name.toLowerCase() === normalized)
  if (nameMatches.length === 1) return nameMatches[0]
  if (nameMatches.length > 1) {
    throw new Error(`More than one group is named “${reference}”. Use a stable group ID.`)
  }
  throw new Error(`No group matches “${reference}”.`)
}

export function applyPrototypeCommand(
  ledger: PrototypeLedger,
  command: PrototypeCommand
): CommandResult {
  switch (command.type) {
    case 'create-group':
      return createGroup(ledger, command.name)
    case 'create-work-item':
      return createWorkItem(ledger, command)
    case 'spawn-placeholder':
    case 'attach-placeholder':
      return putPlaceholder(ledger, command)
    case 'connect-nodes':
      return connectNodes(ledger, command)
    case 'set-work-item-status':
      return setWorkItemStatus(ledger, command.workItemId, command.status)
    case 'select-project-checkout':
    case 'create-workspace':
    case 'attach-workspace':
    case 'spawn-agent':
    case 'attach-agent':
    case 'refresh-paseo':
      throw new Error(`Command “${command.type}” requires the Paseo adapter service.`)
  }
}

function createGroup(ledger: PrototypeLedger, name: string): CommandResult {
  const sequence = ledger.nextSequence
  const id = `group-${sequence}`
  return {
    ledger: {
      ...ledger,
      nextSequence: sequence + 1,
      groups: [
        ...ledger.groups,
        {
          id,
          kind: 'group',
          projectId: ledger.project.id,
          name: requiredText(name, 'Group name'),
          position: groupPosition(ledger.groups.length)
        }
      ]
    },
    affectedId: id
  }
}

function createWorkItem(
  ledger: PrototypeLedger,
  command: Extract<PrototypeCommand, { type: 'create-work-item' }>
): CommandResult {
  const sequence = ledger.nextSequence
  const id = `work-item-${sequence}`
  return {
    ledger: {
      ...ledger,
      nextSequence: sequence + 1,
      groups: [
        ...ledger.groups,
        {
          id,
          kind: 'work-item',
          projectId: ledger.project.id,
          name: requiredText(command.name, 'WorkItem name'),
          position: groupPosition(ledger.groups.length),
          task: requiredText(command.task, 'WorkItem task'),
          sourceRef: command.sourceRef ?? null,
          status: command.status ?? 'active'
        }
      ]
    },
    affectedId: id
  }
}

function putPlaceholder(
  ledger: PrototypeLedger,
  command: Extract<PrototypeCommand, { type: 'spawn-placeholder' | 'attach-placeholder' }>
): CommandResult {
  const group = resolveGroup(ledger, command.targetGroup)
  const existing = ledger.nodes.find(({ resourceRef }) =>
    sameResourceIdentity(resourceRef, command.resourceRef)
  )
  if (existing) {
    if (existing.kind !== command.nodeKind) {
      throw new Error(
        `Resource “${command.resourceRef.provider}:${command.resourceRef.kind}:${command.resourceRef.id}” is already attached as ${existing.kind}, not ${command.nodeKind}.`
      )
    }
    const members = ledger.nodes.filter(({ id, groupId }) => id !== existing.id && groupId === group.id).length
    const updated = {
      ...existing,
      groupId: group.id,
      workItemId: group.kind === 'work-item' ? group.id : existing.workItemId,
      title: requiredText(command.title, 'Placeholder title'),
      position:
        existing.groupId === group.id
          ? existing.position
          : {
              x: group.position.x + 36 + (members % 2) * 244,
              y: group.position.y + 76 + Math.floor(members / 2) * 140
            },
      resourceRef: command.resourceRef
    }
    return {
      ledger: {
        ...ledger,
        nodes: ledger.nodes.map((node) => (node.id === existing.id ? updated : node))
      },
      affectedId: existing.id
    }
  }

  const sequence = ledger.nextSequence
  const id = `node-${sequence}`
  const members = ledger.nodes.filter(({ groupId }) => groupId === group.id).length
  return {
    ledger: {
      ...ledger,
      nextSequence: sequence + 1,
      nodes: [
        ...ledger.nodes,
        {
          id,
          projectId: ledger.project.id,
          groupId: group.id,
          workItemId: group.kind === 'work-item' ? group.id : null,
          kind: command.nodeKind,
          title: requiredText(command.title, 'Placeholder title'),
          position: {
            x: group.position.x + 36 + (members % 2) * 244,
            y: group.position.y + 76 + Math.floor(members / 2) * 140
          },
          resourceRef: command.resourceRef,
          paseo: null
        }
      ]
    },
    affectedId: id
  }
}

function connectNodes(
  ledger: PrototypeLedger,
  command: Extract<PrototypeCommand, { type: 'connect-nodes' }>
): CommandResult {
  requireNode(ledger, command.fromNodeId)
  requireNode(ledger, command.toNodeId)
  const existing = ledger.edges.find(
    (edge) =>
      edge.fromNodeId === command.fromNodeId &&
      edge.toNodeId === command.toNodeId &&
      edge.relation === command.relation
  )
  if (existing) return { ledger, affectedId: existing.id }

  const sequence = ledger.nextSequence
  const id = `edge-${sequence}`
  return {
    ledger: {
      ...ledger,
      nextSequence: sequence + 1,
      edges: [
        ...ledger.edges,
        {
          id,
          fromNodeId: command.fromNodeId,
          toNodeId: command.toNodeId,
          relation: command.relation
        }
      ]
    },
    affectedId: id
  }
}

function setWorkItemStatus(
  ledger: PrototypeLedger,
  workItemId: string,
  status: WorkItemStatus
): CommandResult {
  const target = resolveGroup(ledger, workItemId)
  if (target.kind !== 'work-item') throw new Error(`Group “${workItemId}” is not a WorkItem.`)
  return {
    ledger: {
      ...ledger,
      groups: ledger.groups.map((group) => (group.id === target.id ? { ...group, status } : group))
    },
    affectedId: target.id
  }
}

function requireNode(ledger: PrototypeLedger, id: string): void {
  if (!ledger.nodes.some((node) => node.id === id)) throw new Error(`No node has stable ID “${id}”.`)
}

function groupPosition(index: number): { x: number; y: number } {
  return { x: 120 + (index % 2) * 560, y: 120 + Math.floor(index / 2) * 360 }
}

function requiredText(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required.`)
  return trimmed
}
