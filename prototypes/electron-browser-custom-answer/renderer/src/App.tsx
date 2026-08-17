import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import {
  applyNodeChanges,
  Background,
  Controls,
  Panel,
  ReactFlow,
  useReactFlow,
  type Node,
  type NodeChange,
  type NodeTypes
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { BrowserNode } from './BrowserNode'
import { NativeOverlayNode } from './NativeOverlayNode'
import { BrowserCanvasContext } from './PrototypeContext'
import { PrototypeNodeFrame } from './PrototypeNodeFrame'
import { RichAnswerNode, type ConversationEvent } from './RichAnswerNode'

const ConversationContext = createContext<{
  events: readonly ConversationEvent[]
  append: (event: Omit<ConversationEvent, 'id'>) => void
}>({ events: [], append: () => undefined })

type GroupFlowNode = Node<{ label: string }, 'group'>
type RichFlowNode = Node<Record<string, never>, 'rich-answer'>
type ConversationFlowNode = Node<Record<string, never>, 'conversation'>
type BrowserFlowNode = Node<Record<string, never>, 'browser'>
type NativeOverlayFlowNode = Node<Record<string, never>, 'native-overlay'>
type PrototypeFlowNode =
  | GroupFlowNode
  | RichFlowNode
  | ConversationFlowNode
  | BrowserFlowNode
  | NativeOverlayFlowNode

const initialNodes: PrototypeFlowNode[] = [
  {
    id: 'browser-group',
    type: 'group',
    position: { x: 40, y: 40 },
    style: { width: 720, height: 720 },
    data: { label: 'Browser reparent target · native identity remains explicit' }
  },
  {
    id: 'rich-answer',
    type: 'rich-answer',
    position: { x: 820, y: 40 },
    dragHandle: '.prototype-node__chrome',
    style: { width: 620, height: 700 },
    data: {}
  },
  {
    id: 'mock-conversation',
    type: 'conversation',
    position: { x: 1500, y: 40 },
    dragHandle: '.prototype-node__chrome',
    style: { width: 420, height: 700 },
    data: {}
  },
  {
    id: 'github-browser',
    type: 'browser',
    position: { x: 40, y: 820 },
    dragHandle: '.prototype-node__chrome',
    style: { width: 600, height: 620 },
    data: {}
  },
  {
    id: 'native-overlay',
    type: 'native-overlay',
    position: { x: 820, y: 820 },
    dragHandle: '.prototype-node__chrome',
    style: { width: 600, height: 620 },
    data: {}
  }
]

function RichAnswerFlowNode(): React.JSX.Element {
  const { append } = useContext(ConversationContext)
  return <RichAnswerNode onConversationEvent={append} />
}

function ConversationNode(): React.JSX.Element {
  const { events } = useContext(ConversationContext)

  return (
    <PrototypeNodeFrame title="Mock conversation" kind="deterministic bridge events" resizable>
      <p className="conversation-intro">
        Custom-answer calls append explicit follow-up events here; they do not mutate durable state.
      </p>
      <ol className="conversation-events" aria-label="Mock conversation events">
        {events.length === 0 ? (
          <li className="conversation-events__empty">Submit or annotate inside the custom answer.</li>
        ) : (
          events.map((event) => (
            <li key={event.id}>
              <strong>{event.method}</strong>
              <span>{event.summary}</span>
              <small>runtime {event.runtime}</small>
            </li>
          ))
        )}
      </ol>
    </PrototypeNodeFrame>
  )
}

const nodeTypes = {
  'rich-answer': RichAnswerFlowNode,
  conversation: ConversationNode,
  browser: BrowserNode,
  'native-overlay': NativeOverlayNode
} satisfies NodeTypes

function ViewportProbeControls(): React.JSX.Element {
  const flow = useReactFlow()
  const pan = (offset: number): void => {
    const viewport = flow.getViewport()
    void flow.setViewport({ ...viewport, x: viewport.x + offset }, { duration: 0 })
  }

  return (
    <Panel position="top-right" className="viewport-probes">
      <button type="button" onClick={() => pan(-160)}>Pan left</button>
      <button type="button" onClick={() => pan(160)}>Pan right</button>
    </Panel>
  )
}

export function App(): React.JSX.Element {
  const [nodes, setNodes] = useState(initialNodes)
  const [events, setEvents] = useState<ConversationEvent[]>([])

  const append = useCallback((event: Omit<ConversationEvent, 'id'>) => {
    setEvents((current) => [...current, { ...event, id: current.length + 1 }])
  }, [])

  const parented = nodes.some((node) => node.id === 'github-browser' && node.parentId === 'browser-group')
  const toggleParent = useCallback(() => {
    setNodes((current) => current.map((node) => {
      if (node.id !== 'github-browser') return node

      if (node.parentId) {
        return {
          ...node,
          parentId: undefined,
          extent: undefined,
          position: { x: 40, y: 820 }
        }
      }

      return {
        ...node,
        parentId: 'browser-group',
        extent: 'parent',
        position: { x: 60, y: 70 }
      }
    }))
  }, [])

  const conversation = useMemo(() => ({ events, append }), [append, events])
  const browserCanvas = useMemo(() => ({ parented, toggleParent }), [parented, toggleParent])
  const onNodesChange = useCallback((changes: NodeChange<PrototypeFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current))
  }, [])

  return (
    <ConversationContext.Provider value={conversation}>
      <BrowserCanvasContext.Provider value={browserCanvas}>
        <main className="prototype-shell">
          <header className="prototype-header">
            <div>
              <p>SPADE EXPERIMENT P2</p>
              <h1>Electron browser and custom-answer composition</h1>
            </div>
            <span>Prototype-only entry · trusted content</span>
          </header>
          <section className="prototype-canvas" aria-label="P2 composition canvas">
            <ReactFlow
              nodes={nodes}
              edges={[]}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              nodesConnectable={false}
              minZoom={0.25}
              maxZoom={1.6}
              fitView
              fitViewOptions={{ padding: 0.08 }}
            >
              <Background />
              <Controls />
              <ViewportProbeControls />
            </ReactFlow>
          </section>
        </main>
      </BrowserCanvasContext.Provider>
    </ConversationContext.Provider>
  )
}
