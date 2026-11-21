import { useCallback } from 'react'
import { MiniMap, useReactFlow } from '@xyflow/react'
import { useSession, useStoreState } from '../../store/hooks'
import type { EntityFlowNode } from '../EntityNode'

const MINIMAP_SIZE = { width: 220, height: 150 }

// The overview (plan §12): simplified node rectangles colored by entity type, agents tinted by their activity.
// Clicking or dragging moves the viewport there without recording a focus move.
export function CanvasMiniMap(): React.JSX.Element | null {
  const { minimap } = useSession()
  const runtimes = useStoreState((state) => state.runtimes)
  const flow = useReactFlow()

  const nodeClassName = useCallback(
    (node: EntityFlowNode): string => {
      const type = node.data.record.entityType
      const activity = runtimes.get(node.id)?.activity
      return ['minimap-node', `minimap-node--${type}`, activity ? `minimap-node--activity-${activity}` : ''].filter(Boolean).join(' ')
    },
    [runtimes]
  )

  if (!minimap) return null
  return (
    <MiniMap<EntityFlowNode>
      className="canvas-minimap"
      style={MINIMAP_SIZE}
      position="bottom-right"
      ariaLabel="Minimap"
      pannable
      nodeClassName={nodeClassName}
      nodeBorderRadius={6}
      onClick={(_event, position) => {
        void flow.setCenter(position.x, position.y, { zoom: flow.getZoom() })
      }}
    />
  )
}
