import { useId } from 'react'
import type { SpawnTarget } from '@shared/commands'
import type { Canvas } from '@shared/domain'
import { NodeChooser } from './NodeChooser'

// The three spawn targets of plan §4.6.
export type TargetChoice =
  | { kind: 'source' }
  | { kind: 'pick'; nodeId: string | null; attach: 'node' | 'root' }
  | { kind: 'new-tree' }

export function defaultTargetChoice(sourceNodeId: string | null): TargetChoice {
  return sourceNodeId === null ? { kind: 'new-tree' } : { kind: 'source' }
}

// Null while the choice is incomplete (no node picked yet).
export function spawnTargetOf(choice: TargetChoice, sourceNodeId: string | null): SpawnTarget | null {
  switch (choice.kind) {
    case 'source':
      return sourceNodeId === null ? null : { kind: 'child', parentNodeId: sourceNodeId }
    case 'pick':
      if (choice.nodeId === null) return null
      return choice.attach === 'node'
        ? { kind: 'child', parentNodeId: choice.nodeId }
        : { kind: 'tree', nodeId: choice.nodeId }
    case 'new-tree':
      return { kind: 'new-tree' }
  }
}

type TargetPickerProps = {
  canvas: Canvas
  sourceNodeId: string | null
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
          <span>Child of {source.title}</span>
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
