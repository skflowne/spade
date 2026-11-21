import type { EntityCreateResult } from '../contracts'
import { CanvasCommandError, type CanvasCommand, type NodeSeed } from '../../shared/commands'
import type { Canvas, CanvasNode } from '../../shared/domain'
import type { EntityRegistry } from '../../shared/entities'

export type CreationCommand = Extract<CanvasCommand, { type: 'spawnChild' | 'startTree' }>

export function isCreationCommand(command: CanvasCommand): command is CreationCommand {
  return command.type === 'spawnChild' || command.type === 'startTree'
}

// Checks, against the current canvas, everything the reducer would reject a creation for, so no
// external resource is created for a command that is bound to fail. Returns the parsed config and source.
export function preflightCreation(
  canvas: Canvas,
  command: CreationCommand,
  entities: EntityRegistry
): { config: unknown; sourceNode: CanvasNode | null } {
  const sourceNode = command.type === 'spawnChild' ? requireNode(canvas, command.sourceNodeId) : null
  if (command.type === 'spawnChild' && command.target && command.target.kind !== 'new-tree') {
    requireNode(canvas, command.target.kind === 'child' ? command.target.parentNodeId : command.target.nodeId)
  }

  const { entityType, workspaceId } = command.node
  if (!entities.has(entityType)) {
    throw new CanvasCommandError('unknown-entity-type', `Unknown entity type: ${entityType}`)
  }
  if (typeof workspaceId === 'string' && !canvas.workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw new CanvasCommandError('unknown-workspace', `Unknown workspace: ${workspaceId}`)
  }

  const definition = entities.resolve(entityType)
  try {
    return { config: definition.parseConfig(command.node.config), sourceNode }
  } catch (error) {
    throw new CanvasCommandError('invalid-config', `Invalid ${definition.displayName} config: ${describe(error)}`)
  }
}

// Fields the adapter reports fill only what the seed left unset; `config` and `resourceRef` replace.
export function mergeCreateResult(seed: NodeSeed, result: EntityCreateResult): NodeSeed {
  const merged: NodeSeed = { ...seed, resourceRef: result.resourceRef }
  if (result.config !== undefined) merged.config = result.config
  if (seed.title === undefined && result.title !== undefined) merged.title = result.title
  if (seed.shortDescription === undefined && result.shortDescription !== undefined) {
    merged.shortDescription = result.shortDescription
  }
  if (seed.size === undefined && result.size !== undefined) merged.size = result.size
  if (seed.workspaceId === undefined && result.workspaceId !== undefined) merged.workspaceId = result.workspaceId
  return merged
}

function requireNode(canvas: Canvas, nodeId: string): CanvasNode {
  const node = canvas.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) throw new CanvasCommandError('unknown-node', `Unknown node: ${nodeId}`)
  return node
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
