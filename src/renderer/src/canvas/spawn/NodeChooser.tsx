import { useEffect, useId, useMemo, useRef } from 'react'
import type { Canvas } from '@shared/domain'
import { canvasIndex } from '../model/canvasIndex'
import { EntityTypeIcon } from '../../entities/EntityTypeIcon'

type NodeChooserProps = {
  canvas: Canvas
  value: string | null
  onChange(nodeId: string): void
  onPickOnCanvas(): void
  // Left out of the list, e.g. the node being moved.
  excludeNodeId?: string
}

type Row = { nodeId: string; title: string; icon: React.ReactNode; depth: number; root: boolean }

// Chooses any non-archived node: from the canvas's trees shown as an indented tree, or by clicking it on the canvas.
export function NodeChooser(props: NodeChooserProps): React.JSX.Element {
  const labelId = useId()
  const list = useRef<HTMLUListElement>(null)
  const rows = useMemo<Row[]>(() => {
    const index = canvasIndex(props.canvas)
    return index.tree.roots().flatMap((rootId) =>
      index.tree.branchOf(rootId).flatMap((nodeId) => {
        const node = index.byId.get(nodeId)
        if (!node || node.archived || nodeId === props.excludeNodeId) return []
        return [
          {
            nodeId,
            title: node.title,
            icon: <EntityTypeIcon type={node.entityType} />,
            depth: index.pathTo(nodeId).length - 1,
            root: nodeId === rootId
          }
        ]
      })
    )
  }, [props.canvas, props.excludeNodeId])
  const focusIndex = Math.max(0, rows.findIndex((row) => row.nodeId === props.value))

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [props.value])

  const moveFocus = (from: HTMLElement, step: number | 'first' | 'last'): void => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])]
    const current = items.indexOf(from)
    const next = step === 'first' ? 0 : step === 'last' ? items.length - 1 : Math.min(items.length - 1, Math.max(0, current + step))
    items[next]?.focus()
  }

  return (
    <div className="node-chooser">
      <div className="cr-field">
        <span id={labelId} className="cr-field__label">
          Node
        </span>
        {rows.length === 0 ? (
          <p className="node-tree__empty">No node to choose.</p>
        ) : (
          <ul ref={list} role="tree" aria-labelledby={labelId} className="node-tree">
            {rows.map((row, index) => (
              <li
                key={row.nodeId}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-selected={row.nodeId === props.value}
                tabIndex={index === focusIndex ? 0 : -1}
                className={[
                  'node-tree__item',
                  row.root ? 'node-tree__item--root' : '',
                  row.nodeId === props.value ? 'node-tree__item--selected' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{ '--node-tree-depth': row.depth } as React.CSSProperties}
                onClick={() => props.onChange(row.nodeId)}
                onKeyDown={(event) => {
                  const keys: Record<string, number | 'first' | 'last'> = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' }
                  if (event.key in keys) moveFocus(event.currentTarget, keys[event.key])
                  else if (event.key === 'Enter' || event.key === ' ') props.onChange(row.nodeId)
                  else return
                  event.preventDefault()
                }}
              >
                <span className="node-tree__icon" aria-hidden="true">
                  {row.icon}
                </span>
                <span className="node-tree__title">{row.title}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" className="cr-button" onClick={props.onPickOnCanvas}>
        Pick on canvas
      </button>
    </div>
  )
}
