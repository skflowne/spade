import { expect, test } from '@playwright/test'
import { buildAgentContext, describeNodeForAgent, formatAgentContext } from '../../src/shared/agentContext'
import { AGENT_CONTEXT_EXCERPT_LIMIT, AGENT_CONTEXT_REFERENCE_LIMIT } from '../../src/shared/agents'
import { createBuiltinEntityRegistry } from '../../src/shared/builtinEntities'
import { applyCanvasCommand } from '../../src/shared/canvasReducer'
import { CanvasCommandError, type CanvasCommand, type NodeSeed } from '../../src/shared/commands'
import { createEmptyCanvas, type Canvas } from '../../src/shared/domain'

const entities = createBuiltinEntityRegistry()

function build(steps: Array<[string, CanvasCommand]>): Canvas {
  let canvas = createEmptyCanvas('project')
  let next = 0
  for (const [nodeId, command] of steps) {
    canvas = applyCanvasCommand(canvas, command, {
      actor: { kind: 'user' },
      now: '2026-01-01T00:00:00.000Z',
      entities,
      createId: () => `gen-${++next}`,
      nodeId
    }).canvas
  }
  return canvas
}

const spawn = (source: string, node: NodeSeed): CanvasCommand => ({ type: 'spawnChild', sourceNodeId: source, node, origin: 'spawned' })

// parent ── agent ── child;  agent ⇢ referenced (references edge);  loose stands alone.
function scene(): Canvas {
  return build([
    ['', { type: 'upsertWorkspace', workspace: { id: 'ws', cwd: 'C:\\Work\\Framework', name: 'framework' } }],
    ['parent', { type: 'startTree', node: { entityType: 'note', config: { body: 'Plan:\nship it' }, title: 'Plan', workspaceId: 'ws' } }],
    [
      'agent',
      spawn('parent', {
        entityType: 'agent',
        config: { provider: 'claude', prompt: 'Implement the plan' },
        title: 'Implementer',
        resourceRef: { provider: 'paseo', kind: 'agent', id: 'paseo-7', revision: 'r3' }
      })
    ],
    ['child', spawn('agent', { entityType: 'image', config: { source: { kind: 'path', path: 'C:\\Work\\shot.png' }, caption: 'Result' } })],
    ['referenced', { type: 'startTree', node: { entityType: 'webpage', config: { url: 'https://example.com/spec' }, title: 'Spec' } }],
    ['', { type: 'connectNodes', fromNodeId: 'agent', toNodeId: 'referenced' }],
    ['loose', { type: 'startTree', node: { entityType: 'note', config: { body: '' }, shortDescription: 'scratch' } }],
    [
      '',
      {
        type: 'updateNode',
        nodeId: 'loose',
        patch: { cachedPresentation: { summary: 'Cached summary', revision: 'c1' } }
      }
    ]
  ])
}

test('projects each selected node with its relation to the agent, in selection order', () => {
  const references = buildAgentContext(scene(), entities, 'agent', ['child', 'referenced', 'parent', 'loose'])

  expect(references).toEqual([
    {
      node_type: 'image',
      node_id: 'child',
      node_name: 'Image',
      relation: 'child',
      workspace: { id: 'ws', cwd: 'C:\\Work\\Framework' },
      locator: { kind: 'path', value: 'C:\\Work\\shot.png' },
      excerpt: 'Result'
    },
    {
      node_type: 'webpage',
      node_id: 'referenced',
      node_name: 'Spec',
      relation: 'references',
      locator: { kind: 'url', value: 'https://example.com/spec' }
    },
    {
      node_type: 'note',
      node_id: 'parent',
      node_name: 'Plan',
      relation: 'parent',
      workspace: { id: 'ws', cwd: 'C:\\Work\\Framework' },
      excerpt: 'Plan:\nship it'
    },
    {
      node_type: 'note',
      node_id: 'loose',
      node_name: 'Note',
      short_description: 'scratch',
      relation: 'selected',
      revision: 'c1',
      excerpt: 'Cached summary'
    }
  ])
})

test('a resource-backed node is located by its resource reference', () => {
  expect(describeNodeForAgent(scene(), entities, 'agent')).toEqual({
    node_type: 'agent',
    node_id: 'agent',
    node_name: 'Implementer',
    relation: 'selected',
    workspace: { id: 'ws', cwd: 'C:\\Work\\Framework' },
    locator: { kind: 'paseo:agent', value: 'paseo-7' },
    revision: 'r3',
    excerpt: 'Implement the plan'
  })
})

test('skips the agent itself, duplicates, and unknown ids, and rejects an unknown agent', () => {
  const canvas = scene()
  const references = buildAgentContext(canvas, entities, 'agent', ['agent', 'parent', 'ghost', 'parent'])
  expect(references.map((reference) => reference.node_id)).toEqual(['parent'])

  expect(() => buildAgentContext(canvas, entities, 'ghost', [])).toThrow(CanvasCommandError)
  expect(() => describeNodeForAgent(canvas, entities, 'ghost')).toThrow(CanvasCommandError)
})

test('bounds the number of references and the length of every excerpt and name', () => {
  const longBody = 'x'.repeat(AGENT_CONTEXT_EXCERPT_LIMIT * 3)
  const steps: Array<[string, CanvasCommand]> = [['agent', { type: 'startTree', node: { entityType: 'agent', config: { provider: 'p' } } }]]
  const ids: string[] = []
  for (let index = 0; index < AGENT_CONTEXT_REFERENCE_LIMIT + 5; index += 1) {
    ids.push(`n${index}`)
    steps.push([`n${index}`, spawn('agent', { entityType: 'note', config: { body: longBody }, title: 'T'.repeat(5000) })])
  }
  const references = buildAgentContext(build(steps), entities, 'agent', ids)

  expect(references).toHaveLength(AGENT_CONTEXT_REFERENCE_LIMIT)
  expect(references.map((reference) => reference.node_id)).toEqual(ids.slice(0, AGENT_CONTEXT_REFERENCE_LIMIT))
  for (const reference of references) {
    expect(reference.excerpt!.length).toBeLessThanOrEqual(AGENT_CONTEXT_EXCERPT_LIMIT)
    expect(reference.excerpt!.endsWith('…')).toBe(true)
    expect(reference.node_name.length).toBeLessThan(5000)
  }
})

test('formats references as a compact plain-text block', () => {
  const canvas = scene()
  const text = formatAgentContext(buildAgentContext(canvas, entities, 'agent', ['parent', 'referenced']))

  expect(text).toBe(
    [
      'Canvas context (2 nodes):',
      '- note "Plan" (id parent, parent)',
      '  workspace: C:\\Work\\Framework (id ws)',
      '  excerpt:',
      '    Plan:',
      '    ship it',
      '- webpage "Spec" (id referenced, references)',
      '  locator: url https://example.com/spec'
    ].join('\n')
  )
  expect(formatAgentContext([])).toBe('')
})

test('formats descriptions and revisions on their own lines', () => {
  const text = formatAgentContext([describeNodeForAgent(scene(), entities, 'loose', 'references')])
  expect(text).toBe(
    [
      'Canvas context (1 node):',
      '- note "Note" (id loose, references)',
      '  description: scratch',
      '  revision: c1',
      '  excerpt:',
      '    Cached summary'
    ].join('\n')
  )
})
