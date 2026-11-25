import { useId } from 'react'
import type { Canvas } from '@shared/domain'
import { NodeChooser } from './NodeChooser'
import { agentAnchorOf, spawnTargetOf, type TargetChoice } from './spawnCommand'

type TargetPickerProps = {
  canvas: Canvas
  sourceNodeId: string | null
  // The type of the node being created: a new agent is never attached under an agent node.
  entityType: string
  value: TargetChoice
  onChange(choice: TargetChoice): void
  // Hands the canvas to the user to click a node; the picker gets the result through onChange.
  onPickOnCanvas(): void
}

export function TargetPicker(props: TargetPickerProps): React.JSX.Element {
  const name = useId()
  const attachName = useId()
  const source = props.canvas.nodes.find((node) => node.id === props.sourceNodeId)
  const pick = props.value.kind === 'pick' ? props.value : null
  const sourceAnchor = source ? agentAnchorOf(props.canvas, props.entityType, { kind: 'child', parentNodeId: source.id }) : null
  const pickedAnchor = pick ? agentAnchorOf(props.canvas, props.entityType, spawnTargetOf(pick, props.sourceNodeId)) : null

  return (
    <fieldset className="target-picker">
      <legend>Attach to</legend>
      {source ? (
        <label className="cr-choice">
          <input
            type="radio"
            name={name}
            checked={props.value.kind === 'source'}
            onChange={() => props.onChange({ kind: 'source' })}
          />
          <span>{sourceAnchor ? `Next to ${source.title}, not connected` : `Child of ${source.title}`}</span>
        </label>
      ) : null}
      <label className="cr-choice">
        <input
          type="radio"
          name={name}
          checked={pick !== null}
          onChange={() => props.onChange({ kind: 'pick', nodeId: props.sourceNodeId, attach: 'node' })}
        />
        <span>Pick a tree or node</span>
      </label>
      {pick ? (
        <div className="target-picker__pick">
          <NodeChooser
            canvas={props.canvas}
            value={pick.nodeId}
            onChange={(nodeId) => props.onChange({ ...pick, nodeId })}
            onPickOnCanvas={props.onPickOnCanvas}
          />
          <div className="target-picker__attach" role="radiogroup" aria-label="Attach as">
            <label className="cr-choice">
              <input
                type="radio"
                name={attachName}
                checked={pick.attach === 'node'}
                onChange={() => props.onChange({ ...pick, attach: 'node' })}
              />
              <span>Attach to this node</span>
            </label>
            <label className="cr-choice">
              <input
                type="radio"
                name={attachName}
                checked={pick.attach === 'root'}
                onChange={() => props.onChange({ ...pick, attach: 'root' })}
              />
              <span>Attach to its tree's root</span>
            </label>
          </div>
          {pickedAnchor ? (
            <p className="target-picker__note" data-testid="agent-placement">
              The new agent is placed next to {pickedAnchor.title}, not connected: only Paseo's own children connect to an
              agent.
            </p>
          ) : null}
        </div>
      ) : null}
      <label className="cr-choice">
        <input
          type="radio"
          name={name}
          checked={props.value.kind === 'new-tree'}
          onChange={() => props.onChange({ kind: 'new-tree' })}
        />
        <span>Start a new tree</span>
      </label>
    </fieldset>
  )
}
