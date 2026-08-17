import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import {
  applyNodeChanges,
  Background,
  Controls,
  ReactFlow,
  type Node,
  type NodeChange,
  type NodeTypes
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { PrototypeNodeFrame } from './PrototypeNodeFrame'
import { RichAnswerNode, type ConversationEvent } from './RichAnswerNode'

const ConversationContext = createContext<{
  events: readonly ConversationEvent[]
  append: (event: Omit<ConversationEvent, 'id'>) => void
}>({ events: [], append: () => undefined })

type RichFlowNode = Node<Record<string, never>, 'rich-answer'>
type ConversationFlowNode = Node<Record<string, never>, 'conversation'>
type PrototypeFlowNode = RichFlowNode | ConversationFlowNode

const initialNodes: PrototypeFlowNode[] = [
  {
    id: 'rich-answer',
    type: 'rich-answer',
    position: { x: 100, y: 80 },
    dragHandle: '.prototype-node__chrome',
    style: { width: 620, height: 700 },
    data: {}
  },
  {
    id: 'mock-conversation',
    type: 'conversation',
    position: { x: 800, y: 80 },
    dragHandle: '.prototype-node__chrome',
    style: { width: 420, height: 700 },
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
  conversation: ConversationNode
} satisfies NodeTypes

export function App(): React.JSX.Element {
  const [nodes, setNodes] = useState(initialNodes)
  const [events, setEvents] = useState<ConversationEvent[]>([])

  const append = useCallback((event: Omit<ConversationEvent, 'id'>) => {
    setEvents((current) => [...current, { ...event, id: current.length + 1 }])
  }, [])

  const conversation = useMemo(() => ({ events, append }), [append, events])
  const onNodesChange = useCallback((changes: NodeChange<PrototypeFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current))
  }, [])

  return (
    <ConversationContext.Provider value={conversation}>
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
            minZoom={0.35}
            maxZoom={1.6}
            fitView
            fitViewOptions={{ padding: 0.12 }}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </section>
      </main>
    </ConversationContext.Provider>
  )
}
