import { useEffect, useMemo, useRef } from 'react'
import { entities } from '../../entities'
import { useSpadeStore } from '../../store/hooks'
import { MenuButton } from '../../ui/Menu'
import { usePrompts } from '../../ui/prompts'
import { useCanvasActions, useCanvasData, useCanvasNavigation } from '../CanvasContext'
import { archivedEntries, type ArchivedEntry } from '../model/archivedNodes'
import { canvasIndex } from '../model/canvasIndex'
import { relativeTime } from '../model/activityView'
import { SidePanel, useNow } from './SidePanel'
import { icons } from '../../ui/icons'
import { EntityTypeIcon } from '../../entities/EntityTypeIcon'

// Archived nodes stay hidden on the canvas; this is where they come back from (plan §4.6).
export function ArchivedPanel(): React.JSX.Element {
  const { canvas } = useCanvasData()
  const { panelHighlight } = useCanvasNavigation()
  const entries = useMemo(() => archivedEntries(canvasIndex(canvas)), [canvas])
  const now = useNow(30_000)
  const list = useRef<HTMLOListElement>(null)

  useEffect(() => {
    if (panelHighlight === null) return
    const row = list.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(panelHighlight)}"]`)
    row?.scrollIntoView({ block: 'nearest' })
    row?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [panelHighlight])

  return (
    <SidePanel title="Archived nodes">
      {entries.length === 0 ? (
        <p className="side-panel__empty">Nothing is archived. Archiving hides a node or a branch from the canvas until you restore it.</p>
      ) : (
        <ol ref={list} className="archived-list">
          {entries.map((entry) => (
            <ArchivedRow key={entry.nodeId} entry={entry} now={now} highlighted={entry.nodeId === panelHighlight} />
          ))}
        </ol>
      )}
    </SidePanel>
  )
}

function ArchivedRow({ entry, now, highlighted }: { entry: ArchivedEntry; now: number; highlighted: boolean }): React.JSX.Element {
  const actions = useCanvasActions()
  const store = useSpadeStore()
  const prompts = usePrompts()
  const typeName = entities.has(entry.entityType) ? entities.resolve(entry.entityType).displayName : entry.entityType
  const hasArchivedBelow = entry.archivedInBranch > 1

  const restore = async (branch: boolean): Promise<void> => {
    const response = await actions.execute({ type: 'restoreNode', nodeId: entry.nodeId, ...(branch ? { branch: true } : {}) })
    if (response.ok) store.inform(branch ? `Restored the branch “${entry.title}”.` : `Restored “${entry.title}”.`)
  }

  const remove = async (branch: boolean): Promise<void> => {
    const count = entry.descendantCount + 1
    const confirmed = await prompts.confirm({
      title: branch ? `Remove the branch ${entry.title}?` : `Remove ${entry.title}?`,
      message: (
        <>
          <p>
            {branch
              ? `${entry.title} and everything below it are removed, archived or not: ${count} ${count === 1 ? 'node' : 'nodes'}.`
              : entry.descendantCount === 0
                ? 'It has no children.'
                : 'Its children move up to its parent, or become roots.'}
          </p>
          <p>Only SPADE's records are removed. Nothing on disk or in Paseo is deleted.</p>
        </>
      ),
      confirmLabel: branch ? 'Remove branch' : 'Remove node',
      danger: true
    })
    if (confirmed) await actions.execute({ type: branch ? 'removeBranch' : 'removeNode', nodeId: entry.nodeId })
  }

  const details = [
    typeName,
    `archived ${relativeTime(entry.archivedAt, now)}`,
    hasArchivedBelow ? `${entry.archivedInBranch} nodes in branch` : null
  ].filter((part) => part !== null)

  return (
    <li
      className={highlighted ? 'archived-entry archived-entry--highlighted' : 'archived-entry'}
      data-testid="archived-entry"
      data-node-id={entry.nodeId}
    >
      <span className="archived-entry__icon" aria-hidden="true">
        <EntityTypeIcon type={entry.entityType} />
      </span>
      <div className="archived-entry__text">
        <strong className="archived-entry__title">{entry.title}</strong>
        <span className="archived-entry__meta">{details.join(' · ')}</span>
      </div>
      <button
        type="button"
        className="cr-button archived-entry__restore"
        aria-label={`${hasArchivedBelow ? 'Restore branch' : 'Restore'} ${entry.title}`}
        onClick={() => void restore(hasArchivedBelow)}
      >
        {hasArchivedBelow ? 'Restore branch' : 'Restore'}
      </button>
      <MenuButton
        label={`More actions for ${entry.title}`}
        menuLabel={`Archived ${entry.title}`}
        className="cr-icon-button"
        items={() => [
          hasArchivedBelow
            ? { label: 'Restore this node only', onSelect: () => void restore(false) }
            : { label: 'Restore node', onSelect: () => void restore(false) },
          'separator',
          { label: 'Remove node…', onSelect: () => void remove(false), danger: true },
          ...(entry.descendantCount > 0 ? [{ label: 'Remove branch…', onSelect: () => void remove(true), danger: true }] : [])
        ]}
      >
        <icons.more />
      </MenuButton>
    </li>
  )
}

// The archived count, shown on the panel's toolbar toggle.
export function ArchivedCount(): React.JSX.Element | null {
  const { canvas } = useCanvasData()
  const count = useMemo(() => archivedEntries(canvasIndex(canvas)).length, [canvas])
  if (count === 0) return null
  return (
    <span className="toolbar-count" data-testid="archived-count">
      {count}
    </span>
  )
}
