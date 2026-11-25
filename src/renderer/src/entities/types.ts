import type { ComponentType, ReactNode } from 'react'
import type { CanvasCommand, CanvasCommandResponse, NodeSeed } from '@shared/commands'
import type { CanvasNode, ChildOrigin, Project, SourceArtifact } from '@shared/domain'

// The contract between SPADE's generic node wrapper and an entity's renderer (plan §5.5, §6).
// The wrapper owns chrome, dragging, sizing, menus, and activation; the renderer owns only the body.

// Level of detail (plan §12). 'preview' below the canvas's readable zoom, where body text cannot be read: the
// body should show a cheap overview of itself (no heavy content, no live resources). The wrapper shows the
// title, type and status at a legible size meanwhile. The level changes only when the zoom crosses the threshold.
export type EntityDetail = 'full' | 'preview'

export type NodeStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

// A short badge in the node header. The label is always visible text; tone only reinforces it.
export type NodeStatus = { label: string; tone: NodeStatusTone; description?: string }

export type SpawnRequest = {
  seed: NodeSeed
  origin: ChildOrigin
  // The node the gesture started from: the default parent, and the source of the spawn.
  sourceNodeId: string
  sourceArtifact?: SourceArtifact
}

export type EntityHost = {
  // Runs a canvas command on this node's project. A failure is already shown to the user as a notice.
  execute(command: CanvasCommand): Promise<CanvasCommandResponse>
  // Asks the user for the target (plan §4.6), creates the node, and centers it.
  // Resolves with the new node's id, or null when the user cancels or the command fails.
  // A user who closes the dialog while the node is being created does not cancel it: the promise then resolves
  // when the creation ends, and the node appears without taking focus.
  requestSpawn(request: SpawnRequest): Promise<string | null>
  // Centers the node at a readable zoom.
  focusNode(nodeId: string): void
  // Fills the header status slot while the body is mounted; null clears it.
  setStatus(status: NodeStatus | null): void
  // Shows the user a dismissible error notice, for failures of entity actions.
  notify(message: string): void
}

export type EntityBodyProps<Config = unknown> = {
  node: CanvasNode
  config: Config
  project: Project
  // False: the body shows its content but receives no pointer, wheel, or keyboard input.
  // True: the user clicked the body; its content is interactive until Escape or a click elsewhere.
  active: boolean
  detail: EntityDetail
  host: EntityHost
}

// Rendered in the header even while the node is collapsed, for status derived from records or runtimes.
export type EntityStatusProps<Config = unknown> = {
  node: CanvasNode
  config: Config
  project: Project
  // Marks the whole node as waiting for the user, visibly even while collapsed.
  setAttention(attention: boolean): void
}

export type EntityCreateFormProps = {
  project: Project
  // The form element must carry this id: the dialog's confirm button submits it.
  formId: string
  onSubmit(seed: NodeSeed): void
}

export type EntityMenuAction = {
  id: string
  label: string
  onSelect(): void
  disabled?: boolean
  danger?: boolean
}

export type EntityMenuContext<Config = unknown> = {
  node: CanvasNode
  config: Config
  project: Project
  host: EntityHost
}

export type EntityRendererDefinition<Config = unknown> = {
  // Matches the shared EntityDefinition.type; display name and sizes come from the shared definition.
  type: string
  // A short monogram or glyph shown in the header's icon box.
  icon: ReactNode
  Body: ComponentType<EntityBodyProps<Config>>
  // Omitted: the entity cannot be created from the New node menu or Spawn connected….
  CreateForm?: ComponentType<EntityCreateFormProps>
  Status?: ComponentType<EntityStatusProps<Config>>
  // Entity-specific entries shown above the generic entries in the node menu.
  menuActions?(context: EntityMenuContext<Config>): EntityMenuAction[]
}
