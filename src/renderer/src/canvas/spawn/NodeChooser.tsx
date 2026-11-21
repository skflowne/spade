import { useId } from 'react'
import type { Canvas } from '@shared/domain'
import { indexTree } from '@shared/tree'

type NodeChooserProps = {
  canvas: Canvas
  value: string | null
  onChange(nodeId: string): void
  onPickOnCanvas(): void
  // Left out of the list, e.g. the node being moved.
  excludeNodeId?: string
}

const INDENT = '   '

// Chooses any non-archived node: from a compact list grouped by tree, or by clicking it on the canvas.
export function NodeChooser(props: NodeChooserProps): React.JSX.Element {
  const id = useId()
  const tree = indexTree(props.canvas)
  const byId = new Map(props.canvas.nodes.map((node) => [node.id, node]))
  const depthOf = (nodeId: string): number => {
    let depth = 0
    for (let current = tree.parentOf(nodeId); current !== null; current = tree.parentOf(current)) depth += 1
    return depth
  }
  const trees = tree
    .roots()
    .map((rootId) => tree.branchOf(rootId).filter((nodeId) => !byId.get(nodeId)?.archived && nodeId !== props.excludeNodeId))
    .filter((members) => members.length > 0)

  return (
    <div className="node-chooser">
      <div className="cr-field">
        <label htmlFor={id}>Node</label>
        <select
          id={id}
          className="cr-input"
          value={props.value ?? ''}
          onChange={(event) => {
            if (event.target.value) props.onChange(event.target.value)
          }}
        >
          <option value="" disabled>
            Choose a node…
          </option>
          {trees.map((members) => (
            <optgroup key={members[0]} label={`Tree: ${byId.get(tree.rootOf(members[0]))?.title ?? ''}`}>
              {members.map((nodeId) => (
                <option key={nodeId} value={nodeId}>
                  {INDENT.repeat(depthOf(nodeId))}
                  {byId.get(nodeId)?.title}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <button type="button" className="cr-button" onClick={props.onPickOnCanvas}>
        Pick on canvas
      </button>
    </div>
  )
}
