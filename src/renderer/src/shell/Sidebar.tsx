import { useId, useState } from 'react'
import type { Project } from '@shared/domain'
import { useAppState, useProjectActivity, useSpadeStore } from '../store/hooks'
import { MenuButton } from '../ui/Menu'
import { usePrompts } from '../ui/prompts'
import { PaseoStatus } from './PaseoStatus'

// Switches between project canvases. Everything it shows comes from AppState and agent runtimes.
export function Sidebar(): React.JSX.Element {
  const store = useSpadeStore()
  const app = useAppState()
  const listLabel = useId()
  return (
    <nav className="sidebar" aria-label="Projects">
      <div className="sidebar__brand">
        <span className="sidebar__mark" aria-hidden="true">
          S
        </span>
        <span>SPADE</span>
      </div>
      <button type="button" className="cr-button cr-button--primary sidebar__open" onClick={() => void store.openProject()}>
        Open project…
      </button>
      <h2 id={listLabel} className="sidebar__heading">
        Projects
      </h2>
      <ul className="sidebar__list" aria-labelledby={listLabel}>
        {app?.projects.map((project) => (
          <ProjectRow key={project.id} project={project} selected={project.id === app.selectedProjectId} />
        ))}
      </ul>
      <PaseoStatus />
    </nav>
  )
}

function ProjectRow({ project, selected }: { project: Project; selected: boolean }): React.JSX.Element {
  const store = useSpadeStore()
  const prompts = usePrompts()
  const activity = useProjectActivity(project.id)
  const pathId = useId()
  const [busy, setBusy] = useState(false)

  const rename = async (): Promise<void> => {
    const name = await prompts.promptText({
      title: 'Rename project',
      label: 'Name',
      initialValue: project.name,
      confirmLabel: 'Rename'
    })
    if (name !== null && name !== project.name) await store.renameProject(project.id, name)
  }

  const remove = async (): Promise<void> => {
    const confirmed = await prompts.confirm({
      title: `Remove ${project.name}?`,
      message: (
        <>
          <p>SPADE forgets this project and its canvas.</p>
          <p>
            The directory is not touched: <span className="mono">{project.rootPath}</span> and everything in it stay
            on disk, and nothing in Paseo is deleted.
          </p>
        </>
      ),
      confirmLabel: 'Remove project',
      danger: true
    })
    if (!confirmed) return
    setBusy(true)
    await store.removeProject(project.id)
    setBusy(false)
  }

  return (
    <li className={selected ? 'project-row project-row--selected' : 'project-row'} data-testid="project-item">
      <button
        type="button"
        className="project-row__select"
        aria-current={selected ? 'page' : undefined}
        aria-label={project.name}
        aria-describedby={pathId}
        disabled={busy}
        onClick={() => {
          if (!selected) void store.selectProject(project.id)
        }}
      >
        <span className="project-row__name">{project.name}</span>
        <span id={pathId} className="project-row__path" title={project.rootPath}>
          <bdi>{project.rootPath}</bdi>
        </span>
      </button>
      <ActivityIndicator running={activity.running} attention={activity.attention} />
      <MenuButton
        label={`Project actions for ${project.name}`}
        menuLabel={`Actions for project ${project.name}`}
        className="cr-icon-button project-row__menu"
        items={() => [
          { label: 'Rename…', onSelect: () => void rename() },
          { label: 'Change root…', onSelect: () => void store.changeProjectRoot(project.id) },
          'separator',
          { label: 'Remove…', onSelect: () => void remove(), danger: true }
        ]}
      >
        ⋯
      </MenuButton>
    </li>
  )
}

function ActivityIndicator({ running, attention }: { running: number; attention: number }): React.JSX.Element | null {
  if (running === 0 && attention === 0) return null
  const parts = [
    running > 0 ? `${running} running ${running === 1 ? 'agent' : 'agents'}` : null,
    attention > 0 ? `${attention} ${attention === 1 ? 'agent needs' : 'agents need'} attention` : null
  ].filter((part) => part !== null)
  return (
    <span className="project-activity" role="status" aria-label={parts.join(', ')} title={parts.join(', ')}>
      {running > 0 ? <span className="project-activity__running">{running}</span> : null}
      {attention > 0 ? <span className="project-activity__attention">!</span> : null}
    </span>
  )
}
