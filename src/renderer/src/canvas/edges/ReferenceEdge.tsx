import { BaseEdge, EdgeLabelRenderer, getBezierPath, useStoreApi, type Edge, type EdgeProps } from '@xyflow/react'
import { useCanvasActions } from '../CanvasContext'

export const REFERENCE_EDGE_TYPE = 'reference'

export type ReferenceEdgeData = { label: string | null }
type ReferenceFlowEdge = Edge<ReferenceEdgeData, typeof REFERENCE_EDGE_TYPE>

// A `references` edge (plan §4.6): dashed, optionally labelled, and removable once selected.
export function ReferenceEdge(props: EdgeProps<ReferenceFlowEdge>): React.JSX.Element {
  const actions = useCanvasActions()
  const flowStore = useStoreApi()
  const [path, labelX, labelY] = getBezierPath(props)
  const label = props.data?.label ?? null
  return (
    <>
      <BaseEdge id={props.id} path={path} interactionWidth={18} />
      {label !== null || props.selected ? (
        <EdgeLabelRenderer>
          <div
            className={props.selected ? 'reference-edge-tag reference-edge-tag--selected nodrag nopan' : 'reference-edge-tag nodrag nopan'}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            data-testid="reference-edge-tag"
            // The label is part of the edge: clicking it selects the edge.
            onClick={() => {
              if (!props.selected) flowStore.getState().addSelectedEdges([props.id])
            }}
          >
            {label !== null ? <span className="reference-edge-tag__label">{label}</span> : null}
            {props.selected ? (
              <div className="reference-edge-tag__toolbar" role="toolbar" aria-label="Reference">
                <button
                  type="button"
                  className="cr-button cr-button--ghost reference-edge-tag__remove"
                  onClick={() => void actions.execute({ type: 'disconnectNodes', edgeId: props.id })}
                >
                  Remove reference
                </button>
              </div>
            ) : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}
