import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AgentRuntime } from '@shared/agents'
import type { Canvas } from '@shared/domain'
import { entities, entityRenderers } from '../../entities'
import { useStoreState } from '../../store/hooks'
import { useCanvasActions, useCanvasData } from '../CanvasContext'
import { focusNodeHeader } from '../nodeFocus'
import { canvasIndex } from '../model/canvasIndex'
import { searchNodes, type SearchCandidate } from '../model/search'
import { canvasShortcut } from '../model/shortcuts'

type Candidate = SearchCandidate & { icon: React.ReactNode; inCollapsedBranch: boolean }

// Archived nodes are not searchable; nodes hidden by a collapsed branch are, and jumping to one expands it.
function candidatesOf(canvas: Canvas, runtimes: ReadonlyMap<string, AgentRuntime>): Candidate[] {
  const index = canvasIndex(canvas)
  return canvas.nodes
    .filter((node) => !node.archived)
    .map((node) => ({
      nodeId: node.id,
      title: node.title,
      typeLabel: entities.has(node.entityType) ? entities.resolve(node.entityType).displayName : node.entityType,
      status: runtimes.get(node.id)?.activity ?? null,
      icon: entityRenderers.get(node.entityType)?.icon ?? '?',
      inCollapsedBranch: index.hidden.has(node.id)
    }))
}

// Searches the canvas's nodes by title, type, and status (plan §12). Ctrl+K or Ctrl+F focuses it.
export function SearchBox(): React.JSX.Element {
  const { canvas } = useCanvasData()
  const actions = useCanvasActions()
  const runtimes = useStoreState((state) => state.runtimes)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()

  const candidates = useMemo(() => candidatesOf(canvas, runtimes), [canvas, runtimes])
  const byId = useMemo(() => new Map(candidates.map((candidate) => [candidate.nodeId, candidate])), [candidates])
  const results = useMemo(() => searchNodes(candidates, query), [candidates, query])
  const showList = open && query.trim() !== ''
  const active = Math.min(activeIndex, Math.max(0, results.length - 1))

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || canvasShortcut(event)?.kind !== 'search') return
      if (document.querySelector('dialog[open]')) return
      event.preventDefault()
      input.current?.focus()
      input.current?.select()
      setOpen(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const jump = (nodeId: string): void => {
    setOpen(false)
    input.current?.blur()
    actions.focusNode(nodeId)
    focusNodeHeader(nodeId)
  }

  return (
    <div className="search-box">
      <span className="search-box__glyph" aria-hidden="true">
        ⌕
      </span>
      <input
        ref={input}
        type="search"
        className="cr-input search-box__input"
        role="combobox"
        aria-label="Search nodes"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && results.length > 0 ? `${listId}-${active}` : undefined}
        placeholder="Search nodes"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActiveIndex(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
            if (results.length > 0) setActiveIndex((active + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            const result = results[active]
            if (showList && result) jump(result.nodeId)
          } else if (event.key === 'Escape') {
            // Escape belongs to the search box here, not to the canvas behind it.
            event.preventDefault()
            if (showList) setOpen(false)
            else if (query) setQuery('')
            else input.current?.blur()
          }
        }}
      />
      <kbd className="search-box__hint" aria-hidden="true">
        Ctrl K
      </kbd>
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Search results"
          className="search-results"
          // Keeps focus in the input while choosing with the pointer.
          onMouseDown={(event) => event.preventDefault()}
        >
          {results.length === 0 ? (
            <li className="search-results__empty" role="presentation">
              No node matches “{query.trim()}”.
            </li>
          ) : (
            results.map((result, index) => {
              const candidate = byId.get(result.nodeId)!
              return (
                <li
                  key={result.nodeId}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className={index === active ? 'search-result search-result--active' : 'search-result'}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => jump(result.nodeId)}
                >
                  <span className="search-result__icon" aria-hidden="true">
                    {candidate.icon}
                  </span>
                  <span className="search-result__title">{result.title}</span>
                  <span className="search-result__meta">
                    {result.typeLabel}
                    {result.status ? ` · ${result.status}` : ''}
                    {candidate.inCollapsedBranch ? ' · in a collapsed branch' : ''}
                  </span>
                </li>
              )
            })
          )}
        </ul>
      ) : null}
    </div>
  )
}
