import { useId, useMemo, useState } from 'react'
import { entityRenderers } from '../../entities'
import { useCanvasActions, useCanvasData } from '../CanvasContext'
import { activityItems, relativeTime, type ActivityActorView } from '../model/activityView'
import { SidePanel, useNow } from './SidePanel'

// Who changed what (plan §4.6): the canvas's activity log, newest first.
export function ActivityPanel(): React.JSX.Element {
  const { canvas } = useCanvasData()
  const actions = useCanvasActions()
  const [agentsOnly, setAgentsOnly] = useState(false)
  const filterId = useId()
  const now = useNow(30_000)
  const items = useMemo(() => activityItems(canvas, { agentsOnly }), [canvas, agentsOnly])

  return (
    <SidePanel
      title="Activity"
      tools={
        <label className="cr-check" htmlFor={filterId}>
          <input id={filterId} type="checkbox" checked={agentsOnly} onChange={(event) => setAgentsOnly(event.target.checked)} />
          <span>Agents only</span>
        </label>
      }
    >
      {items.length === 0 ? (
        <p className="side-panel__empty">{agentsOnly ? 'No agent has changed this canvas yet.' : 'Nothing has changed yet.'}</p>
      ) : (
        <ol className="activity-list" aria-label="Changes, newest first">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`activity-entry activity-entry--${item.actor.kind}`}
                data-testid="activity-entry"
                data-actor={item.actor.kind}
                disabled={item.targetNodeId === null}
                title={item.targetNodeId === null ? 'The changed nodes were removed or archived' : 'Show the changed node'}
                onClick={() => {
                  if (item.targetNodeId !== null) actions.focusNode(item.targetNodeId)
                }}
              >
                <span className="activity-entry__head">
                  <Actor actor={item.actor} />
                  <time dateTime={item.at} title={new Date(item.at).toLocaleString()}>
                    {relativeTime(item.at, now)}
                  </time>
                </span>
                <span className="activity-entry__summary">{item.summary}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </SidePanel>
  )
}

function Actor({ actor }: { actor: ActivityActorView }): React.JSX.Element {
  const icon =
    actor.kind === 'agent' ? (actor.entityType ? (entityRenderers.get(actor.entityType)?.icon ?? 'A') : 'A') : actor.kind === 'system' ? 'S' : null
  return (
    <span className="activity-entry__actor" data-testid="activity-actor">
      {icon !== null ? (
        <span className="activity-entry__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="activity-entry__name">{actor.label}</span>
    </span>
  )
}
