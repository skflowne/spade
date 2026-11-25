import { Panel } from '@xyflow/react'
import { MenuButton } from '../../ui/Menu'
import { useCanvasActions, useCanvasData, useCanvasNavigation } from '../CanvasContext'
import { archivedEntryOf } from '../model/archivedNodes'
import { canvasIndex } from '../model/canvasIndex'
import { icons } from '../../ui/icons'
import { EntityTypeIcon } from '../../entities/EntityTypeIcon'

// Path segments shown before the rest fold into a menu: the root and the last few.
const SHOWN_TAIL = 3

// The strip along the canvas's top edge that the shown bar covers, in screen pixels: its margin and height
// (app.css, .focus-bar and .breadcrumb). Focusing a node keeps its header below it.
export const FOCUS_BAR_BAND = 48

// The current-focus indicator (plan §12): the focused node's path from its root, each segment a jump.
export function FocusBar(): React.JSX.Element | null {
  const { canvas } = useCanvasData()
  const { currentNodeId } = useCanvasNavigation()
  const actions = useCanvasActions()
  if (currentNodeId === null) return null
  const index = canvasIndex(canvas)
  const path = index.pathTo(currentNodeId)
  if (path.length === 0) return null

  const go = (nodeId: string): void => {
    if (index.byId.get(nodeId)?.archived) actions.openPanel('archived', archivedEntryOf(index, nodeId) ?? undefined)
    else actions.focusNode(nodeId)
  }
  const folded = path.length > SHOWN_TAIL + 1 ? path.slice(1, path.length - SHOWN_TAIL) : []
  const shown = folded.length > 0 ? [path[0], ...path.slice(path.length - SHOWN_TAIL)] : path

  return (
    <Panel position="top-left" className="focus-bar">
      <nav aria-label="Current focus">
        <ol className="breadcrumb">
          {shown.map((nodeId, position) => {
            const node = index.byId.get(nodeId)!
            const isCurrent = nodeId === currentNodeId
            return (
              <li key={nodeId} className="breadcrumb__item">
                {position > 0 ? (
                  <span className="breadcrumb__separator" aria-hidden="true">
                    <icons.pathSeparator />
                  </span>
                ) : null}
                {position === 1 && folded.length > 0 ? (
                  <>
                    <MenuButton
                      label={`${folded.length} more`}
                      menuLabel="Folded path"
                      className="breadcrumb__segment breadcrumb__segment--folded"
                      items={() =>
                        folded.map((id) => ({ label: index.byId.get(id)?.title ?? id, onSelect: () => go(id) }))
                      }
                    >
                      <icons.more />
                    </MenuButton>
                    <span className="breadcrumb__separator" aria-hidden="true">
                      <icons.pathSeparator />
                    </span>
                  </>
                ) : null}
                <button
                  type="button"
                  className={[
                    'breadcrumb__segment',
                    isCurrent ? 'breadcrumb__segment--current' : '',
                    node.archived ? 'breadcrumb__segment--archived' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-current={isCurrent ? 'location' : undefined}
                  title={node.archived ? `${node.title} (archived)` : node.title}
                  onClick={() => go(nodeId)}
                >
                  <span className="breadcrumb__icon" aria-hidden="true">
                    <EntityTypeIcon type={node.entityType} />
                  </span>
                  <span className="breadcrumb__title">{node.title}</span>
                </button>
              </li>
            )
          })}
        </ol>
      </nav>
    </Panel>
  )
}
