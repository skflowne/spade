import { useId, useMemo, useRef, useState } from 'react'
import { AGENT_CONTEXT_REFERENCE_LIMIT } from '@shared/agents'
import type { Canvas, CanvasNode } from '@shared/domain'
import { indexTree } from '@shared/tree'
import { useCanvasActions, useCanvasData } from '../../canvas/CanvasContext'
import { entities } from '../registry'
import { Popover } from './Popover'

type ComposerProps = {
  nodeId: string
  // Why the agent cannot be prompted; null when it can.
  blocked: string | null
  running: boolean
  // Resolves with the failure message, or null when the prompt was accepted.
  send(text: string, contextNodeIds: string[]): Promise<string | null>
  interrupt(): Promise<void>
}

type Relation = 'parent' | 'child' | 'references' | 'selected'

const RELATION_LABELS: Record<Relation, string> = {
  parent: 'parent',
  child: 'child',
  references: 'reference',
  selected: 'picked'
}

// The prompt input with explicit context selection (plan §9): the nodes being shared are always shown.
export function Composer({ nodeId, blocked, running, send, interrupt }: ComposerProps): React.JSX.Element {
  const { canvas } = useCanvasData()
  const [text, setText] = useState('')
  const [context, setContext] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [interrupting, setInterrupting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const inputId = useId()
  const hintId = useId()
  const connected = useMemo(() => connectedNodes(canvas, nodeId), [canvas, nodeId])
  const byId = useMemo(() => new Map(canvas.nodes.map((node) => [node.id, node])), [canvas])
  // A shared node that was removed from the canvas is no longer shared.
  const shared = context.filter((id) => byId.has(id))
  const canSend = blocked === null && !sending && text.trim().length > 0

  const submit = async (): Promise<void> => {
    if (!canSend) return
    setSending(true)
    setFailure(null)
    const problem = await send(text, shared)
    setSending(false)
    if (problem === null) {
      setText('')
      setContext([])
    } else {
      setFailure(problem)
    }
  }

  return (
    <form
      className="agent-composer"
      aria-label="Message the agent"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {shared.length > 0 ? (
        <ul className="agent-context" aria-label="Shared with the agent">
          {shared.map((id) => {
            const node = byId.get(id)!
            return (
              <li key={id} className="agent-context__chip">
                <span className="agent-context__relation">{RELATION_LABELS[relationOf(connected, id)]}</span>
                <span className="agent-context__title">{node.title}</span>
                <button
                  type="button"
                  className="agent-context__remove"
                  aria-label={`Stop sharing ${node.title}`}
                  title="Stop sharing"
                  onClick={() => setContext(context.filter((candidate) => candidate !== id))}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
      <label htmlFor={inputId} className="agent-composer__label">
        Message
      </label>
      <textarea
        id={inputId}
        className="cr-input agent-composer__input"
        rows={2}
        value={text}
        disabled={blocked !== null}
        aria-describedby={blocked ? hintId : undefined}
        placeholder={blocked ? '' : 'Message the agent. Enter sends, Shift+Enter adds a line.'}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void submit()
          }
        }}
      />
      <div className="agent-composer__actions">
        <ContextPicker
          nodeId={nodeId}
          connected={connected}
          selected={shared}
          disabled={blocked !== null}
          onChange={setContext}
        />
        {blocked ? (
          <span id={hintId} className="agent-composer__hint">
            {blocked}
          </span>
        ) : (
          <span className="agent-composer__hint">{sending ? 'Sending…' : ''}</span>
        )}
        {running ? (
          <button
            type="button"
            className="cr-button"
            disabled={blocked !== null || interrupting}
            onClick={() => {
              setInterrupting(true)
              void interrupt().finally(() => setInterrupting(false))
            }}
          >
            Interrupt
          </button>
        ) : null}
        <button type="submit" className="cr-button cr-button--primary" disabled={!canSend}>
          Send
        </button>
      </div>
      {failure ? (
        <p className="agent-composer__failure" role="alert">
          Could not send: {failure}
        </p>
      ) : null}
    </form>
  )
}

type Connected = Array<{ node: CanvasNode; relation: Relation }>

function connectedNodes(canvas: Canvas, nodeId: string): Connected {
  const tree = indexTree(canvas)
  const byId = new Map(canvas.nodes.map((node) => [node.id, node]))
  const result: Connected = []
  const add = (id: string | null, relation: Relation): void => {
    const node = id === null ? undefined : byId.get(id)
    if (node && !node.archived && node.id !== nodeId && !result.some((entry) => entry.node.id === node.id)) {
      result.push({ node, relation })
    }
  }
  add(tree.parentOf(nodeId), 'parent')
  for (const child of tree.childrenOf(nodeId)) add(child, 'child')
  for (const edge of canvas.edges) {
    if (edge.relation !== 'references') continue
    if (edge.fromNodeId === nodeId) add(edge.toNodeId, 'references')
    else if (edge.toNodeId === nodeId) add(edge.fromNodeId, 'references')
  }
  return result
}

function relationOf(connected: Connected, id: string): Relation {
  return connected.find((entry) => entry.node.id === id)?.relation ?? 'selected'
}

function ContextPicker(props: {
  nodeId: string
  connected: Connected
  selected: string[]
  disabled: boolean
  onChange(selected: string[]): void
}): React.JSX.Element {
  const actions = useCanvasActions()
  const { canvas } = useCanvasData()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const full = props.selected.length >= AGENT_CONTEXT_REFERENCE_LIMIT
  const toggle = (id: string, on: boolean): void =>
    props.onChange(on ? [...props.selected, id] : props.selected.filter((candidate) => candidate !== id))
  const picked = props.selected.filter((id) => !props.connected.some((entry) => entry.node.id === id))

  const pick = async (): Promise<void> => {
    setOpen(false)
    const id = await actions.pickNode('Click a node to share it with the agent.')
    if (id !== null && id !== props.nodeId && !props.selected.includes(id) && !full) props.onChange([...props.selected, id])
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="cr-button cr-button--ghost"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => setOpen(!open)}
      >
        Attach context{props.selected.length > 0 ? ` (${props.selected.length})` : ''}
      </button>
      {open && trigger.current ? (
        <Popover anchor={trigger.current} label="Attach context" onClose={() => setOpen(false)} className="agent-context-picker">
          <p className="agent-context-picker__title">Share with the agent</p>
          {props.connected.length === 0 && picked.length === 0 ? (
            <p className="agent-context-picker__empty">No connected nodes.</p>
          ) : null}
          {props.connected.map(({ node, relation }) => (
            <ContextOption
              key={node.id}
              node={node}
              relation={relation}
              checked={props.selected.includes(node.id)}
              disabled={full && !props.selected.includes(node.id)}
              onToggle={(on) => toggle(node.id, on)}
            />
          ))}
          {picked.map((id) => {
            const node = canvas.nodes.find((candidate) => candidate.id === id)
            return node ? (
              <ContextOption key={id} node={node} relation="selected" checked onToggle={(on) => toggle(id, on)} />
            ) : null
          })}
          <div className="agent-context-picker__footer">
            {full ? <span className="agent-context-picker__hint">At most {AGENT_CONTEXT_REFERENCE_LIMIT} nodes.</span> : null}
            <button type="button" className="cr-button" disabled={full} onClick={() => void pick()}>
              Pick a node…
            </button>
          </div>
        </Popover>
      ) : null}
    </>
  )
}

function ContextOption(props: {
  node: CanvasNode
  relation: Relation
  checked: boolean
  disabled?: boolean
  onToggle(on: boolean): void
}): React.JSX.Element {
  const type = entities.has(props.node.entityType) ? entities.resolve(props.node.entityType).displayName : props.node.entityType
  return (
    <label className="cr-choice agent-context-picker__option">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onToggle(event.target.checked)}
      />
      <span className="agent-context-picker__name">{props.node.title}</span>
      <span className="agent-context-picker__meta mono">
        {type} · {RELATION_LABELS[props.relation]}
      </span>
    </label>
  )
}
