import { useReactFlow, useStore } from '@xyflow/react'
import { entityRenderers } from '../entities'
import { MenuButton } from '../ui/Menu'
import { useCanvasActions, useCanvasData } from './CanvasContext'
import { canvasToolbarItems } from './extensions'

export function Toolbar(): React.JSX.Element {
  const { project } = useCanvasData()
  const actions = useCanvasActions()
  const flow = useReactFlow()
  const zoom = useStore((state) => state.transform[2])
  const percent = `${Math.round(zoom * 100)}%`

  return (
    <div className="canvas-toolbar">
      <div className="canvas-toolbar__project">
        <h1>{project.name}</h1>
        <span className="mono" title={project.rootPath}>
          {project.rootPath}
        </span>
      </div>
      <div className="canvas-toolbar__controls" role="toolbar" aria-label="Canvas">
        <MenuButton
          label="New node"
          menuLabel="New node"
          title="Add a node as a new tree"
          className="cr-button cr-button--primary"
          items={() =>
            entityRenderers.creatable().map(({ definition }) => ({
              label: definition.displayName,
              onSelect: () => actions.openCreate({ entityType: definition.type })
            }))
          }
        >
          <span aria-hidden="true">＋</span> New node
        </MenuButton>
        <span className="canvas-toolbar__divider" aria-hidden="true" />
        <button type="button" className="cr-button cr-button--ghost" onClick={actions.fitAll}>
          Fit all
        </button>
        <button type="button" className="cr-icon-button" aria-label="Zoom out" title="Zoom out" onClick={() => void flow.zoomOut()}>
          −
        </button>
        <button
          type="button"
          className="cr-button cr-button--ghost canvas-toolbar__zoom"
          aria-label="Zoom to 100%"
          title={`Zoom to 100% (now ${percent})`}
          onClick={() => void flow.zoomTo(1)}
        >
          {percent}
        </button>
        <button type="button" className="cr-icon-button" aria-label="Zoom in" title="Zoom in" onClick={() => void flow.zoomIn()}>
          +
        </button>
        {canvasToolbarItems.map((Item, index) => (
          <Item key={index} />
        ))}
      </div>
    </div>
  )
}
