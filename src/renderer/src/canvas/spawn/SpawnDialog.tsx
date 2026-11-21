import { useId, useState } from 'react'
import type { CanvasCommand, CanvasCommandResponse, NodeSeed } from '@shared/commands'
import { entities, entityRenderers } from '../../entities'
import type { SpawnRequest } from '../../entities/types'
import { Dialog } from '../../ui/Dialog'
import { useCanvasActions, useCanvasData } from '../CanvasContext'
import { defaultTargetChoice, spawnTargetOf, TargetPicker, type TargetChoice } from './TargetPicker'

export type SpawnDialogMode =
  // New node from the toolbar (entityType set, no source) or Spawn connected… from a node (source set).
  | { kind: 'create'; entityType: string | null; sourceNodeId: string | null }
  // An entity asked to spawn a node it already described (EntityHost.requestSpawn).
  | { kind: 'seeded'; request: SpawnRequest }

type SpawnDialogProps = {
  mode: SpawnDialogMode
  // False while the user picks a node on the canvas; the dialog keeps its state.
  open: boolean
  // Runs the creation for this dialog's own request; closing the dialog when it succeeds is the caller's.
  onCreate(command: CanvasCommand): Promise<CanvasCommandResponse>
  // Escape, Cancel, or Close while the node is being created (the creation still completes).
  onCancel(): void
}

// Builds the command for a seed and a target. Without a source, the picked node is the source.
export function spawnCommand(input: {
  seed: NodeSeed
  sourceNodeId: string | null
  choice: TargetChoice
  origin: SpawnRequest['origin']
  sourceArtifact?: SpawnRequest['sourceArtifact']
}): CanvasCommand | null {
  const target = spawnTargetOf(input.choice, input.sourceNodeId)
  if (target === null) return null
  if (input.sourceNodeId === null) {
    if (target.kind === 'new-tree') return { type: 'startTree', node: input.seed }
    const anchor = target.kind === 'child' ? target.parentNodeId : target.nodeId
    return { type: 'spawnChild', sourceNodeId: anchor, node: input.seed, target, origin: input.origin }
  }
  return {
    type: 'spawnChild',
    sourceNodeId: input.sourceNodeId,
    node: input.seed,
    target,
    origin: input.origin,
    ...(input.sourceArtifact ? { sourceArtifact: input.sourceArtifact } : {})
  }
}

export function SpawnDialog({ mode, open, onCreate, onCancel }: SpawnDialogProps): React.JSX.Element {
  const { canvas, project } = useCanvasData()
  const actions = useCanvasActions()
  const formId = useId()
  const sourceNodeId = mode.kind === 'seeded' ? mode.request.sourceNodeId : mode.sourceNodeId
  const source = canvas.nodes.find((node) => node.id === sourceNodeId)
  const creatable = entityRenderers.creatable()
  const [entityType, setEntityType] = useState(
    mode.kind === 'seeded' ? mode.request.seed.entityType : (mode.entityType ?? creatable[0]?.renderer.type ?? '')
  )
  const [choice, setChoice] = useState<TargetChoice>(defaultTargetChoice(sourceNodeId))
  const [busy, setBusy] = useState(false)
  // Also shown as a notice; repeated here because the modal dialog covers the notices.
  const [failure, setFailure] = useState<string | null>(null)
  const displayName = entities.has(entityType) ? entities.resolve(entityType).displayName : entityType
  const CreateForm = mode.kind === 'create' ? entityRenderers.get(entityType)?.CreateForm : undefined
  const complete = spawnTargetOf(choice, sourceNodeId) !== null

  const title =
    mode.kind === 'seeded'
      ? `Spawn ${displayName.toLowerCase()} from ${source?.title ?? 'node'}`
      : source
        ? `Spawn from ${source.title}`
        : `New ${displayName.toLowerCase()}`

  const spawn = async (seed: NodeSeed): Promise<void> => {
    const command = spawnCommand({
      seed,
      sourceNodeId,
      choice,
      origin: mode.kind === 'seeded' ? mode.request.origin : 'spawned',
      sourceArtifact: mode.kind === 'seeded' ? mode.request.sourceArtifact : undefined
    })
    if (command === null || busy) return
    setBusy(true)
    setFailure(null)
    const response = await onCreate(command)
    setBusy(false)
    if (!response.ok) setFailure(response.error.message)
  }

  const pickOnCanvas = async (): Promise<void> => {
    const nodeId = await actions.pickNode('Click a node to attach the new node to it.')
    if (nodeId !== null) setChoice({ kind: 'pick', nodeId, attach: choice.kind === 'pick' ? choice.attach : 'node' })
  }

  return (
    <Dialog
      open={open}
      wide
      title={title}
      onCancel={onCancel}
      footer={
        <>
          {busy ? (
            <p className="spawn-progress" role="status">
              Creating the node… You can close this dialog: the node still appears when it is ready, without moving your
              view.
            </p>
          ) : null}
          <button type="button" className="cr-button" onClick={onCancel}>
            {busy ? 'Close' : 'Cancel'}
          </button>
          {mode.kind === 'seeded' ? (
            <button
              type="button"
              className="cr-button cr-button--primary"
              disabled={!complete || busy}
              onClick={() => void spawn(mode.request.seed)}
            >
              Create
            </button>
          ) : (
            <button type="submit" form={formId} className="cr-button cr-button--primary" disabled={!complete || busy}>
              Create
            </button>
          )}
        </>
      }
    >
      {mode.kind === 'create' && mode.sourceNodeId !== null ? (
        <fieldset className="type-picker">
          <legend>Type</legend>
          {creatable.map(({ definition, renderer }) => (
            <label key={definition.type} className="cr-choice cr-choice--tile">
              <input
                type="radio"
                name={`${formId}-type`}
                checked={entityType === definition.type}
                onChange={() => setEntityType(definition.type)}
              />
              <span className="cr-choice__icon" aria-hidden="true">
                {renderer.icon}
              </span>
              <span>{definition.displayName}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {mode.kind === 'seeded' ? (
        <p className="spawn-summary">
          <span className="mono">{displayName}</span> {mode.request.seed.title ?? ''}
        </p>
      ) : CreateForm ? (
        <div className="spawn-form">
          <CreateForm key={entityType} project={project} formId={formId} onSubmit={(seed) => void spawn(seed)} />
        </div>
      ) : null}
      <TargetPicker
        canvas={canvas}
        sourceNodeId={sourceNodeId}
        value={choice}
        onChange={setChoice}
        onPickOnCanvas={() => void pickOnCanvas()}
      />
      {failure ? (
        <p className="cr-dialog__failure" role="alert">
          {failure}
        </p>
      ) : null}
    </Dialog>
  )
}
