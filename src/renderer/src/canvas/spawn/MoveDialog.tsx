import { useId, useState } from 'react'
import { indexTree } from '@shared/tree'
import { Dialog } from '../../ui/Dialog'
import { useCanvasActions, useCanvasData } from '../CanvasContext'
import { NodeChooser } from './NodeChooser'

type MoveDialogProps = {
  nodeId: string
  open: boolean
  onDone(): void
}

// Reparents a node with its whole branch. The main process rejects cycles; the rejection shows as a notice.
export function MoveDialog({ nodeId, open, onDone }: MoveDialogProps): React.JSX.Element {
  const { canvas } = useCanvasData()
  const actions = useCanvasActions()
  const name = useId()
  const node = canvas.nodes.find((candidate) => candidate.id === nodeId)
  const [mode, setMode] = useState<'root' | 'under'>('under')
  const [parentId, setParentId] = useState<string | null>(null)
  const isRoot = indexTree(canvas).parentOf(nodeId) === null

  const move = async (): Promise<void> => {
    const newParentId = mode === 'root' ? null : parentId
    if (mode === 'under' && newParentId === null) return
    onDone()
    await actions.execute({ type: 'reparent', nodeId, newParentId })
  }

  return (
    <Dialog
      open={open}
      title={`Move ${node?.title ?? 'node'}`}
      description={<p>The node moves with everything below it. Its position on the canvas does not change.</p>}
      onCancel={onDone}
      footer={
        <>
          <button type="button" className="cr-button" onClick={onDone}>
            Cancel
          </button>
          <button
            type="button"
            className="cr-button cr-button--primary"
            disabled={mode === 'under' && parentId === null}
            onClick={() => void move()}
          >
            Move
          </button>
        </>
      }
    >
      <fieldset className="target-picker">
        <legend>New place</legend>
        <label className="cr-choice">
          <input type="radio" name={name} checked={mode === 'under'} onChange={() => setMode('under')} />
          <span>Under a node</span>
        </label>
        <div className="target-picker__pick">
          <NodeChooser
            canvas={canvas}
            value={parentId}
            excludeNodeId={nodeId}
            onChange={(id) => {
              setParentId(id)
              setMode('under')
            }}
            onPickOnCanvas={() =>
              void actions.pickNode('Click the node to move it under.').then((id) => {
                if (id === null) return
                setParentId(id)
                setMode('under')
              })
            }
          />
        </div>
        <label className="cr-choice">
          <input type="radio" name={name} checked={mode === 'root'} disabled={isRoot} onChange={() => setMode('root')} />
          <span>Make it a root{isRoot ? ' (it already is one)' : ''}</span>
        </label>
      </fieldset>
    </Dialog>
  )
}
