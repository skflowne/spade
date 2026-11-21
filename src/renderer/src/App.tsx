import { useEffect, useState } from 'react'
import '@xyflow/react/dist/style.css'
import './app.css'
import { ProjectCanvas } from './canvas/ProjectCanvas'
import { EmptyState } from './shell/EmptyState'
import { Notices } from './shell/Notices'
import { Sidebar } from './shell/Sidebar'
import { StoreContext, useAppState, useSelectedProject, useStoreState } from './store/hooks'
import { SpadeStore } from './store/store'
import { PromptsProvider } from './ui/prompts'

export function App(): React.JSX.Element {
  const [store] = useState(() => new SpadeStore(window.spadeHost))
  useEffect(() => store.start(), [store])
  return (
    <StoreContext.Provider value={store}>
      <PromptsProvider>
        <Shell />
      </PromptsProvider>
    </StoreContext.Provider>
  )
}

function Shell(): React.JSX.Element {
  const app = useAppState()
  const project = useSelectedProject()
  const startupError = useStoreState((state) => state.startupError)
  return (
    <div className="app-shell" data-testid="app-shell">
      <Sidebar />
      <main className="workspace">
        {project ? <ProjectCanvas key={project.id} project={project} /> : null}
        {app && app.projects.length === 0 ? <EmptyState /> : null}
        {startupError ? (
          <div className="canvas-loading" role="alert">
            SPADE could not read its state: {startupError}
          </div>
        ) : null}
        <Notices />
      </main>
    </div>
  )
}
