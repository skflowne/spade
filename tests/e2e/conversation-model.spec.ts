import { expect, test } from '@playwright/test'
import type { ConversationItem } from '../../src/shared/agents'
import type { Artifact } from '../../src/shared/artifacts'
import { agentEntity } from '../../src/shared/builtinEntities'
import type { ConversationExpansionPreferences } from '../../src/shared/domain'
import type { PathInfo } from '../../src/shared/ipc'
import { presentArtifact } from '../../src/renderer/src/entities/agent/artifactActions'
import { effectiveExpansion, paneKindOf, withOverride } from '../../src/renderer/src/entities/agent/expansion'
import { splitMessage } from '../../src/renderer/src/entities/agent/messageSegments'
import { agentStatusOf, lastAssistantExcerpt } from '../../src/renderer/src/entities/agent/status'
import { AnnotationStore } from '../../src/renderer/src/entities/agent/annotations'
import { createAnswerSubmitter, formatSubmission } from '../../src/renderer/src/entities/agent/submission'
import { mergeNewestPage, mergeOlderPage, type TimelineState } from '../../src/renderer/src/entities/agent/timeline'
import type { AgentRuntime } from '../../src/shared/agents'

const at = '2026-01-01T00:00:00.000Z'

function message(id: string, text: string): ConversationItem {
  return { id, timestamp: at, kind: 'assistant-message', text, images: [] }
}

function tool(id: string, toolKind: Extract<ConversationItem, { kind: 'tool-call' }>['toolKind'], diff: string | null = null): ConversationItem {
  return {
    id,
    timestamp: at,
    kind: 'tool-call',
    callId: `call-${id}`,
    toolKind,
    name: toolKind,
    status: 'completed',
    summary: id,
    input: null,
    output: null,
    error: null,
    diff,
    path: null,
    images: []
  }
}

function page(epoch: string | null, items: ConversationItem[], olderCursor: string | null = null) {
  return { epoch, items, olderCursor }
}

const ids = (state: TimelineState | null): string[] => state?.items.map((item) => item.id) ?? []

test.describe('timeline merging', () => {
  test('the first newest page becomes the timeline', () => {
    const state = mergeNewestPage(null, page('e1', [message('a', 'A'), message('b', 'B')], 'cursor-a'))
    expect(ids(state)).toEqual(['a', 'b'])
    expect(state.olderCursor).toBe('cursor-a')
    expect(state.epoch).toBe('e1')
  })

  test('a newer page within the epoch updates items by id, appends new ones, and keeps loaded older items', () => {
    let state = mergeNewestPage(null, page('e1', [message('c', 'C'), message('d', 'D')], 'cursor-c'))
    state = mergeOlderPage(state, page('e1', [message('a', 'A'), message('b', 'B')], null))!
    expect(ids(state)).toEqual(['a', 'b', 'c', 'd'])
    expect(state.olderCursor).toBeNull()

    // The newest window slid forward by one: d streamed more text and e arrived.
    const next = mergeNewestPage(state, page('e1', [message('d', 'D more'), message('e', 'E')], 'cursor-d'))
    expect(ids(next)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(next.items[3]).toMatchObject({ text: 'D more' })
    // Older items were loaded explicitly; the newest page's cursor must not forget them.
    expect(next.olderCursor).toBeNull()
  })

  test('unchanged items keep their object identity so rendered items do not update', () => {
    const first = mergeNewestPage(null, page('e1', [message('a', 'A'), message('b', 'B')]))
    const next = mergeNewestPage(first, page('e1', [message('a', 'A'), message('b', 'B and more')]))
    expect(next.items[0]).toBe(first.items[0])
    expect(next.items[1]).not.toBe(first.items[1])
  })

  test('a new epoch replaces everything', () => {
    let state = mergeNewestPage(null, page('e1', [message('c', 'C')], 'cursor-c'))
    state = mergeOlderPage(state, page('e1', [message('a', 'A')], null))!
    const next = mergeNewestPage(state, page('e2', [message('x', 'X')], 'cursor-x'))
    expect(ids(next)).toEqual(['x'])
    expect(next.olderCursor).toBe('cursor-x')
    expect(next.epoch).toBe('e2')
  })

  test('a newest page that does not overlap the loaded items replaces them', () => {
    const state = mergeNewestPage(null, page('e1', [message('a', 'A')], null))
    const next = mergeNewestPage(state, page('e1', [message('y', 'Y'), message('z', 'Z')], 'cursor-y'))
    expect(ids(next)).toEqual(['y', 'z'])
    expect(next.olderCursor).toBe('cursor-y')
  })

  test('an older page from another epoch is rejected', () => {
    const state = mergeNewestPage(null, page('e1', [message('c', 'C')], 'cursor-c'))
    expect(mergeOlderPage(state, page('e2', [message('a', 'A')], null))).toBeNull()
  })

  test('an older page never duplicates items already loaded', () => {
    const state = mergeNewestPage(null, page('e1', [message('b', 'B'), message('c', 'C')], 'cursor-b'))
    const next = mergeOlderPage(state, page('e1', [message('a', 'A'), message('b', 'B')], null))!
    expect(ids(next)).toEqual(['a', 'b', 'c'])
  })
})

test.describe('conversation expansion', () => {
  const global: ConversationExpansionPreferences = { toolCall: true, diff: true, html: true, thinking: false, read: false }

  test('the per-conversation override wins over the global preference key by key', () => {
    expect(effectiveExpansion(global, undefined)).toEqual(global)
    expect(effectiveExpansion(global, { read: true, toolCall: false })).toEqual({ ...global, read: true, toolCall: false })
  })

  test('each pane takes its type from the item', () => {
    expect(paneKindOf(tool('r', 'read'))).toBe('read')
    expect(paneKindOf(tool('e', 'edit', '@@ -1 +1 @@\n-a\n+b'))).toBe('diff')
    expect(paneKindOf(tool('e2', 'edit'))).toBe('toolCall')
    expect(paneKindOf(tool('s', 'shell'))).toBe('toolCall')
    expect(paneKindOf({ id: 't', timestamp: at, kind: 'thinking', text: 'hmm' })).toBe('thinking')
    expect(paneKindOf(message('m', 'hi'))).toBeNull()
  })

  test('an override equal to the global value is dropped so it keeps following the global value', () => {
    expect(withOverride(undefined, 'read', true, global)).toEqual({ read: true })
    expect(withOverride({ read: true }, 'read', false, global)).toBeUndefined()
    expect(withOverride({ read: true }, 'thinking', true, global)).toEqual({ read: true, thinking: true })
  })

  test('the agent config keeps a valid override and rejects an invalid one', () => {
    const base = { provider: 'claude', model: null, mode: null, prompt: null }
    expect(agentEntity.parseConfig({ ...base, expansion: { read: true } })).toEqual({ ...base, expansion: { read: true } })
    expect(agentEntity.parseConfig({ ...base, expansion: {} })).toEqual(base)
    expect(() => agentEntity.parseConfig({ ...base, expansion: { read: 'yes' } })).toThrow('expansion.read')
    expect(() => agentEntity.parseConfig({ ...base, expansion: { everything: true } })).toThrow('expansion.everything')
  })
})

test.describe('HTML answer submissions', () => {
  test('a submission names its answer and carries the message, the data as JSON, and the annotations', () => {
    const text = formatSubmission({
      title: 'Plan review',
      message: 'Approved',
      data: { step: 2, notes: ['a'] },
      annotations: [
        { id: '1', target: 'step-1', text: 'Too vague' },
        { id: '2', text: 'Consider caching', data: { line: 3 } }
      ]
    })
    expect(text).toBe(
      [
        '[Submitted from the HTML answer “Plan review”]',
        'Approved',
        'Data: {"step":2,"notes":["a"]}',
        'Annotations:',
        '- [step-1] Too vague',
        '- Consider caching {"line":3}'
      ].join('\n')
    )
  })

  test('a submission with only data is still an explicit, non-empty message', () => {
    expect(formatSubmission({ title: null, data: 'yes', annotations: [] })).toBe(
      ['[Submitted from an HTML answer]', 'Data: "yes"'].join('\n')
    )
  })

  test('data that cannot be written as JSON is described rather than lost', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(formatSubmission({ title: null, message: 'm', data: cyclic, annotations: [] })).toContain('Data: [object Object]')
  })

  function scripted(): {
    annotations: AnnotationStore
    sent: string[]
    settle(problem: string | null): void
    submit: ReturnType<typeof createAnswerSubmitter>
  } {
    const annotations = new AnnotationStore()
    const sent: string[] = []
    const replies: Array<(problem: string | null) => void> = []
    const submit = createAnswerSubmitter({
      annotations,
      blocked: () => null,
      prompt: (text) => {
        sent.push(text)
        return new Promise((resolve) => replies.push(resolve))
      }
    })
    return { annotations, sent, settle: (problem) => replies.shift()!(problem), submit }
  }

  test('a second submission from the same answer while one is in flight is refused, so annotations go out once', async () => {
    const { annotations, sent, settle, submit } = scripted()
    annotations.add('a#0', { text: 'Too vague' })
    const first = submit('a#0', 'Plan', { message: 'Approved' })
    await expect(submit('a#0', 'Plan', { message: 'Approved' })).rejects.toThrow(/still being sent/)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('- Too vague')
    // The annotations left with the submission; one made meanwhile waits for the next one.
    expect(annotations.get('a#0')).toEqual([])
    annotations.add('a#0', { text: 'Later' })
    settle(null)
    await first
    expect(annotations.get('a#0').map((annotation) => annotation.text)).toEqual(['Later'])
    // Other answers are independent, and the answer can submit again once the first one settled.
    const other = submit('a#1', null, { message: 'x' })
    const again = submit('a#0', 'Plan', { message: 'Again' })
    expect(sent).toHaveLength(3)
    settle(null)
    settle(null)
    await Promise.all([other, again])
  })

  test('a failed submission puts its annotations back ahead of ones made meanwhile', async () => {
    const { annotations, settle, submit } = scripted()
    annotations.add('a#0', { text: 'First' })
    const attempt = submit('a#0', null, { message: 'Go' })
    annotations.add('a#0', { text: 'Second' })
    settle('The agent is busy')
    await expect(attempt).rejects.toThrow('The agent is busy')
    expect(annotations.get('a#0').map((annotation) => annotation.text)).toEqual(['First', 'Second'])
  })

  test('a blocked agent refuses the submission without taking the annotations', async () => {
    const annotations = new AnnotationStore()
    annotations.add('a#0', { text: 'Kept' })
    const submit = createAnswerSubmitter({ annotations, blocked: () => 'Paseo is unreachable.', prompt: async () => null })
    await expect(submit('a#0', null, { message: 'Go' })).rejects.toThrow('Paseo is unreachable.')
    expect(annotations.get('a#0')).toHaveLength(1)
  })
})

test.describe('artifact actions', () => {
  const pathArtifact = (value: string, isImage = false): Artifact => ({ kind: 'path', value, line: null, column: null, isImage })
  const info = (input: string, kind: PathInfo['kind'], isImage = false): PathInfo => ({
    input,
    absolutePath: kind === 'missing' ? '' : `/project/${input}`,
    kind,
    isImage,
    line: null
  })

  test('a file can be revealed and its path copied', () => {
    expect(presentArtifact(pathArtifact('src/a.ts'), info('src/a.ts', 'file'))).toEqual({
      state: 'file',
      quiet: false,
      actions: ['reveal', 'copy-path']
    })
  })

  test('an image file adds the thumbnail actions and spawning an Image node', () => {
    expect(presentArtifact(pathArtifact('shot.png', true), info('shot.png', 'file', true))).toEqual({
      state: 'image',
      quiet: false,
      actions: ['enlarge', 'spawn-image', 'reveal', 'copy-path']
    })
  })

  test('a folder opens in Explorer', () => {
    expect(presentArtifact(pathArtifact('src/'), info('src/', 'directory'))).toEqual({
      state: 'folder',
      quiet: false,
      actions: ['open-folder', 'copy-path']
    })
  })

  test('a missing absolute path is disabled with only copying left; a missing relative one is quiet', () => {
    expect(presentArtifact(pathArtifact('/gone/file.txt'), info('/gone/file.txt', 'missing'))).toEqual({
      state: 'missing',
      quiet: false,
      actions: ['copy-path']
    })
    expect(presentArtifact(pathArtifact('C:\\gone\\file.txt'), info('C:\\gone\\file.txt', 'missing')).quiet).toBe(false)
    expect(presentArtifact(pathArtifact('Deno/Node.js'), info('Deno/Node.js', 'missing'))).toEqual({
      state: 'missing',
      quiet: true,
      actions: ['copy-path']
    })
  })

  test('an unchecked path offers only copying until its existence is known', () => {
    expect(presentArtifact(pathArtifact('src/a.ts'), undefined)).toEqual({ state: 'checking', quiet: false, actions: ['copy-path'] })
  })

  test('a link opens as a Web page node, in the browser, or is copied', () => {
    const url: Artifact = { kind: 'url', value: 'https://example.com/a', line: null, column: null, isImage: false }
    expect(presentArtifact(url, undefined)).toEqual({
      state: 'url',
      quiet: false,
      actions: ['spawn-webpage', 'open-browser', 'copy-url']
    })
  })
})

test.describe('assistant message segments', () => {
  test('top-level live HTML answers are split out with their titles; everything else stays Markdown', () => {
    const source = 'Intro text\n\n```spade-html Plan review\n<p>hi</p>\n```\n\nAfter **text**\n'
    const segments = splitMessage(source)
    expect(segments).toEqual([
      { type: 'markdown', source: 'Intro text\n\n' },
      { type: 'html', html: '<p>hi</p>', title: 'Plan review' },
      { type: 'markdown', source: '\n\nAfter **text**\n' }
    ])
  })

  test('a fence still being streamed is pending instead of rendering a partial answer or diagram', () => {
    expect(splitMessage('Look:\n\n```spade-html\n<p>partial')).toEqual([
      { type: 'markdown', source: 'Look:\n\n' },
      { type: 'pending', language: 'spade-html' }
    ])
    expect(splitMessage('```mermaid\ngraph TD\nA-->')).toEqual([{ type: 'pending', language: 'mermaid' }])
    // A closed diagram stays inside the Markdown.
    expect(splitMessage('```mermaid\ngraph TD\nA-->B\n```\n')).toEqual([
      { type: 'markdown', source: '```mermaid\ngraph TD\nA-->B\n```\n' }
    ])
  })

  test('a fence still being streamed inside a list or a quote is pending too', () => {
    expect(splitMessage('Steps:\n\n- First\n- Diagram:\n\n  ```mermaid\n  graph TD\n  A-->')).toEqual([
      { type: 'markdown', source: 'Steps:\n\n- First\n- Diagram:\n\n' },
      { type: 'pending', language: 'mermaid' }
    ])
    expect(splitMessage('Intro\n\n> Note\n>\n> ```spade-html\n> <p>partial')).toEqual([
      { type: 'markdown', source: 'Intro\n\n> Note\n>\n' },
      { type: 'pending', language: 'spade-html' }
    ])
    // Closed, or ordinary code, the nested fence stays inside the Markdown.
    const closed = '- Diagram:\n\n  ```mermaid\n  graph TD\n  A-->B\n  ```\n'
    expect(splitMessage(closed)).toEqual([{ type: 'markdown', source: closed }])
    const code = '- Code:\n\n  ```ts\n  const a ='
    expect(splitMessage(code)).toEqual([{ type: 'markdown', source: code }])
  })
})

test.describe('agent status', () => {
  const runtime = (overrides: Partial<AgentRuntime> = {}): AgentRuntime => ({
    projectId: 'p',
    nodeId: 'n',
    agentId: 'a',
    resourceState: 'live',
    parentAgentId: null,
    provider: 'claude',
    model: 'opus',
    mode: 'plan',
    title: null,
    status: 'running',
    activity: 'running',
    cwd: '/project',
    pendingPermissions: [],
    providerSubagents: [],
    lastError: null,
    updatedAt: at,
    ...overrides
  })

  test('the header shows the activity with provider, model, and mode as detail', () => {
    expect(agentStatusOf(runtime())).toEqual({ label: 'running', tone: 'info', description: 'claude · opus · plan · running' })
    expect(agentStatusOf(runtime({ activity: 'idle', status: 'idle' }))).toMatchObject({ label: 'idle', tone: 'success' })
    expect(agentStatusOf(runtime({ activity: 'error', lastError: 'boom' }))).toMatchObject({ label: 'error', tone: 'danger' })
    expect(agentStatusOf(runtime({ activity: 'closed' }))).toMatchObject({ label: 'closed', tone: 'neutral' })
  })

  test('pending permissions, a stale daemon, and a lost agent outrank the activity', () => {
    const request = { id: 'r', kind: 'tool', name: 'Bash', title: null, description: null, detail: null }
    expect(agentStatusOf(runtime({ pendingPermissions: [request] }))).toMatchObject({ label: 'needs attention', tone: 'warning' })
    expect(agentStatusOf(runtime({ activity: 'attention' }))).toMatchObject({ label: 'needs attention', tone: 'warning' })
    expect(agentStatusOf(runtime({ resourceState: 'stale' }))).toMatchObject({ label: 'stale', tone: 'neutral' })
    expect(agentStatusOf(runtime({ resourceState: 'missing' }))).toMatchObject({ label: 'missing', tone: 'danger' })
  })

  test('the preview excerpt is the last assistant message, flattened and clipped', () => {
    const items = [message('a', 'First'), tool('t', 'shell'), message('b', 'Second\n\nline'), tool('u', 'read')]
    expect(lastAssistantExcerpt(items, 100)).toBe('Second line')
    expect(lastAssistantExcerpt([message('a', 'x'.repeat(20))], 10)).toBe(`${'x'.repeat(9)}…`)
    expect(lastAssistantExcerpt([tool('t', 'shell')], 10)).toBeNull()
  })
})
