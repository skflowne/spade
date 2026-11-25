import { useReactFlow, useStore } from '@xyflow/react'
import { entityRenderers } from '../entities'
import { useSession, useSpadeStore } from '../store/hooks'
import { MenuButton } from '../ui/Menu'
import { useCanvasActions, useCanvasData, useCanvasNavigation } from './CanvasContext'
import { canvasSidePanels, canvasToolbarItems } from './extensions'
import { SearchBox } from './navigation/SearchBox'
import { ShortcutsHelp } from './navigation/ShortcutsHelp'

export function Toolbar(): React.JSX.Element {
  const { project } = useCanvasData()
  const actions = useCanvasActions()
  const navigation = useCanvasNavigation()
  const store = useSpadeStore()
  const { minimap } = useSession()
  const flow = useReactFlow()
  // A primitive selector at the readout's precision: zoom frames that round the same re-render nothing.
  const zoomPercent = useStore((state) => Math.round(state.transform[2] * 100))
  const percent = `${zoomPercent}%`

  return (
    <div className="canvas-toolbar">
      <div className="canvas-toolbar__project">
        <h1>{project.name}</h1>
        <span className="mono" title={project.rootPath}>
          {project.rootPath}
        </span>
      </div>
      <div className="canvas-toolbar__controls" role="toolbar" aria-label="Canvas">
        <button
          type="button"
          className="cr-icon-button"
          aria-label="Back"
          title="Back (Alt+←)"
          disabled={!navigation.canGoBack}
          onClick={actions.goBack}
        >
          ‹
        </button>
        <button
          type="button"
          className="cr-icon-button"
          aria-label="Forward"
          title="Forward (Alt+→)"
          disabled={!navigation.canGoForward}
          onClick={actions.goForward}
        >
          ›
        </button>
        <SearchBox />
        <span className="canvas-toolbar__divider" aria-hidden="true" />
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
        <span className="canvas-toolbar__divider" aria-hidden="true" />
        {canvasSidePanels.map(({ id, label, Badge }) => (
          <button
            key={id}
            type="button"
            className="cr-button cr-button--ghost canvas-toolbar__toggle"
            aria-pressed={navigation.panel === id}
            onClick={() => actions.togglePanel(id)}
          >
            {label}
            {Badge ? (
              <>
                {' '}
                <Badge />
              </>
            ) : null}
          </button>
        ))}
        <button
          type="button"
          className="cr-icon-button canvas-toolbar__icon-toggle"
          aria-label="Minimap"
          title={minimap ? 'Hide the minimap' : 'Show the minimap'}
          aria-pressed={minimap}
          onClick={() => store.setSession({ minimap: !minimap })}
        >
          <span aria-hidden="true">▣</span>
        </button>
        <ShortcutsHelp />
        {canvasToolbarItems.map((Item, index) => (
          <Item key={index} />
        ))}
      </div>
    </div>
  )
}
