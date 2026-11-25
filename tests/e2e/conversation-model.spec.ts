import { expect, test } from '@playwright/test'
import type { ConversationItem } from '../../src/shared/agents'
import type { Artifact } from '../../src/shared/artifacts'
import { agentEntity } from '../../src/shared/builtinEntities'
import type { ConversationExpansionPreferences } from '../../src/shared/domain'
import type { PathInfo } from '../../src/shared/ipc'
import { decodeImageDataUrl, presentArtifact } from '../../src/renderer/src/entities/agent/artifactActions'
import { effectiveExpansion, paneKindOf, withOverride } from '../../src/renderer/src/entities/agent/expansion'
import { splitMessage } from '../../src/renderer/src/entities/agent/messageSegments'
import { NEGATIVE_RECHECK_MS, PathChecks, type PathCheck } from '../../src/renderer/src/entities/agent/pathChecks'
import { agentStatusOf, lastAssistantExcerpt } from '../../src/renderer/src/entities/agent/status'
import { AnnotationStore } from '../../src/renderer/src/entities/agent/annotations'
import {
  conversationState,
  forgetConversationState,
  noteTimelineChanged,
  remainingDraft
} from '../../src/renderer/src/entities/agent/conversationState'
import { createAnswerSubmitter, formatSubmission } from '../../src/renderer/src/entities/agent/submission'
import { mergeNewestPage, mergeOlderPage, type TimelineState } from '../../src/renderer/src/entities/agent/timeline'
import type { AgentRuntime, ChildAgentInfo } from '../../src/shared/agents'
import {
  childAttention,
  collapsedDescendants,
  modeLabel,
  runTransitions
} from '../../src/renderer/src/entities/agent/children'
import { ProviderCatalog } from '../../src/renderer/src/entities/agent/providerCatalog'

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

  test('a path offers only copying until its existence is known', () => {
    expect(presentArtifact(pathArtifact('src/a.ts'), undefined)).toEqual({ state: 'checking', quiet: false, actions: ['copy-path'] })
  })

  test('a network path not checked yet can be checked on request, revealed, or copied', () => {
    expect(presentArtifact(pathArtifact('\\\\server\\share\\a.md'), info('\\\\server\\share\\a.md', 'unchecked'))).toEqual({
      state: 'unchecked',
      quiet: false,
      actions: ['check', 'reveal', 'copy-path']
    })
  })

  test('a path whose check failed is neither missing nor quiet', () => {
    expect(presentArtifact(pathArtifact('Deno/Node.js'), 'failed')).toEqual({ state: 'unknown', quiet: false, actions: ['copy-path'] })
  })

  test('a link opens as a Web page node, in the browser, or is copied', () => {
    const url: Artifact = { kind: 'url', value: 'https://example.com/a', line: null, column: null, isImage: false }
    expect(presentArtifact(url, undefined)).toEqual({
      state: 'url',
      quiet: false,
      actions: ['spawn-webpage', 'open-browser', 'copy-url']
    })
  })

  test('an inline image decodes from base64 and from percent-encoded UTF-8 text', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    expect(decodeImageDataUrl(`data:image/png;base64,${Buffer.from(png).toString('base64')}`)).toEqual({ mimeType: 'image/png', bytes: png })
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>✓ é</text></svg>'
    const utf8 = new Uint8Array(Buffer.from(svg, 'utf8'))
    expect(decodeImageDataUrl(`data:image/svg+xml,${encodeURIComponent(svg)}`)).toEqual({ mimeType: 'image/svg+xml', bytes: utf8 })
    expect(decodeImageDataUrl(`data:image/svg+xml;charset=utf-8,${svg}`)).toEqual({ mimeType: 'image/svg+xml', bytes: utf8 })
  })

  test('an inline image that cannot be decoded is reported, not thrown', () => {
    expect(decodeImageDataUrl('data:image/png;base64,@@not base64@@')).toBeNull()
    expect(decodeImageDataUrl('data:image/svg+xml,%E0%A4%A')).toBeNull()
    expect(decodeImageDataUrl('data:text/plain,hello')).toBeNull()
  })
})

test.describe('path checks', () => {
  type Answer = PathInfo['kind'] | 'reject'

  function scripted(projectRoot: string): {
    checks: PathChecks
    calls: Array<[string, boolean]>
    answer(path: string, value: Answer): void
    advance(ms: number): void
  } {
    const calls: Array<[string, boolean]> = []
    const answers = new Map<string, Answer>()
    let clock = 0
    const checks = new PathChecks({
      projectRoot,
      now: () => clock,
      inspect: async (path, explicit) => {
        calls.push([path, explicit])
        const answer = answers.get(path) ?? 'missing'
        if (answer === 'reject') throw new Error('bridge down')
        return { input: path, absolutePath: path, kind: answer, isImage: false, line: null }
      }
    })
    return { checks, calls, answer: (path, value) => answers.set(path, value), advance: (ms) => (clock += ms) }
  }

  const kindOf = (check: PathCheck | undefined): string | undefined =>
    check?.status === 'done' ? check.info.kind : check?.status

  test('a network path outside the project is never touched until an explicit check approves it', async () => {
    const { checks, calls, answer } = scripted('C:\\work\\project')
    const share = '\\\\server\\share\\spec.md'
    expect(kindOf(await checks.check(share))).toBe('unchecked')
    expect(kindOf(await checks.check('//server/share/spec.md'))).toBe('unchecked')
    expect(kindOf(await checks.check('\\\\?\\UNC\\server\\share\\spec.md'))).toBe('unchecked')
    expect(kindOf(await checks.check(share, { refresh: true }))).toBe('unchecked')
    expect(checks.mayTouch(share)).toBe(false)
    expect(calls).toEqual([])

    answer(share, 'file')
    expect(kindOf(await checks.check(share, { explicit: true }))).toBe('file')
    expect(calls).toEqual([[share, true]])
    expect(checks.mayTouch(share)).toBe(true)
    expect(checks.mayTouch('\\\\SERVER\\share\\spec.md')).toBe(true)
    expect(checks.mayTouch('\\\\server\\share\\other.md')).toBe(false)

    // Local and relative paths are checked passively.
    await checks.check('C:\\elsewhere\\a.txt')
    await checks.check('src/a.ts')
    expect(calls.slice(1)).toEqual([
      ['C:\\elsewhere\\a.txt', false],
      ['src/a.ts', false]
    ])
  })

  test('a network path inside a project rooted on a share is an ordinary path', async () => {
    const { checks, calls } = scripted('\\\\server\\share\\project')
    expect(kindOf(await checks.check('\\\\server\\share\\project\\a.md'))).toBe('missing')
    expect(calls).toEqual([['\\\\server\\share\\project\\a.md', false]])
  })

  test('the main process can also answer unchecked; only an explicit check asks again', async () => {
    const { checks, calls, answer } = scripted('C:\\project')
    answer('Z:\\mapped\\a.md', 'unchecked')
    await checks.check('Z:\\mapped\\a.md')
    await checks.check('Z:\\mapped\\a.md', { refresh: true })
    expect(calls).toEqual([['Z:\\mapped\\a.md', false]])
    answer('Z:\\mapped\\a.md', 'file')
    expect(kindOf(await checks.check('Z:\\mapped\\a.md', { explicit: true }))).toBe('file')
  })

  test('missing and failed results are checked again later or on request; existing paths are not', async () => {
    const { checks, calls, answer, advance } = scripted('/project')
    let notified = 0
    checks.subscribe(() => (notified += 1))

    expect(kindOf(await checks.check('out/report.txt'))).toBe('missing')
    expect(kindOf(await checks.check('out/report.txt'))).toBe('missing')
    expect(calls).toHaveLength(1)

    // Expiring right away would re-check on every streamed chunk; the caller learns when to expire again.
    answer('out/report.txt', 'file')
    advance(400)
    expect(checks.expireNegatives()).toBe(NEGATIVE_RECHECK_MS - 400)
    await checks.check('out/report.txt')
    expect(calls).toHaveLength(1)
    advance(NEGATIVE_RECHECK_MS - 400)
    expect(checks.expireNegatives()).toBeNull()
    expect(kindOf(await checks.check('out/report.txt'))).toBe('file')
    expect(calls).toHaveLength(2)
    advance(NEGATIVE_RECHECK_MS)
    checks.expireNegatives()
    await checks.check('out/report.txt', { refresh: true })
    expect(calls).toHaveLength(2)

    // A click re-checks a missing path at once.
    await checks.check('notes.md')
    answer('notes.md', 'file')
    expect(kindOf(await checks.check('notes.md', { refresh: true }))).toBe('file')

    // A failing bridge is not a missing path, and the next attempt asks again.
    answer('flaky.txt', 'reject')
    expect(kindOf(await checks.check('flaky.txt'))).toBe('failed')
    answer('flaky.txt', 'file')
    expect(kindOf(await checks.check('flaky.txt', { refresh: true }))).toBe('file')
    expect(notified).toBeGreaterThanOrEqual(5)
  })

  test('a check in flight is shared, and keeps the previous result visible meanwhile', async () => {
    const { checks, calls, answer, advance } = scripted('/project')
    await checks.check('a.txt')
    answer('a.txt', 'file')
    advance(NEGATIVE_RECHECK_MS)
    checks.expireNegatives()
    const first = checks.check('a.txt')
    const second = checks.check('a.txt')
    expect(kindOf(checks.get('a.txt'))).toBe('missing')
    await Promise.all([first, second])
    expect(calls).toHaveLength(2)
    expect(kindOf(checks.get('a.txt'))).toBe('file')
    expect(checks.get('never-checked.txt')).toBeUndefined()
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
    children: [],
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

test.describe('Paseo children on their owner', () => {
  const child = (agentId: string, overrides: Partial<ChildAgentInfo> = {}): ChildAgentInfo => ({
    agentId,
    title: null,
    provider: 'claude',
    model: 'opus',
    mode: 'default',
    status: 'idle',
    activity: 'idle',
    resourceState: 'live',
    pendingPermissions: [],
    lastError: null,
    updatedAt: at,
    nodeId: null,
    children: [],
    ...overrides
  })
  const request = { id: 'r', kind: 'tool', name: 'Bash', title: null, description: null, detail: null }

  test('a child shows the same status as an agent node, permissions first', () => {
    expect(agentStatusOf(child('c', { activity: 'running', status: 'running' }))).toMatchObject({ label: 'running', tone: 'info' })
    expect(agentStatusOf(child('c', { pendingPermissions: [request] }))).toMatchObject({ label: 'needs attention', tone: 'warning' })
  })

  test('collapsed descendants are the children without a node, and their own children, depth first', () => {
    const tree = [
      child('a', { children: [child('a1', { children: [child('a1x')] }), child('a2')] }),
      child('b', { nodeId: 'node-b' }),
      child('c')
    ]
    expect(collapsedDescendants(tree).map((entry) => entry.agentId)).toEqual(['a', 'a1', 'a1x', 'a2', 'c'])
  })

  test('counts what waits on the user among collapsed descendants only', () => {
    const tree = [
      child('a', { pendingPermissions: [request, { ...request, id: 'r2' }], children: [child('a1', { activity: 'error', lastError: 'boom' })] }),
      // An expanded child's node shows its own state.
      child('b', { nodeId: 'node-b', pendingPermissions: [request], activity: 'error' }),
      child('c')
    ]
    expect(childAttention(tree, new Set(['c', 'b']))).toEqual({ permissions: 2, errors: 1, finished: 1 })
    expect(childAttention([], new Set())).toEqual({ permissions: 0, errors: 0, finished: 0 })
  })

  test('a collapsed child that stops running finished a run; one that starts again has not', () => {
    const before = [child('a', { activity: 'running' }), child('b', { activity: 'idle' }), child('c', { activity: 'starting', children: [child('c1', { activity: 'running' })] })]
    const after = [child('a', { activity: 'idle' }), child('b', { activity: 'running' }), child('c', { activity: 'closed', children: [child('c1', { activity: 'running' })] })]
    expect(runTransitions(before, after)).toEqual({ finished: ['a', 'c'], resumed: ['b'] })
    // Errors are their own signal, and an expanded child is followed on its own node.
    expect(runTransitions([child('a', { activity: 'running' })], [child('a', { activity: 'error' })]).finished).toEqual([])
    expect(runTransitions([child('a', { activity: 'running' })], [child('a', { activity: 'idle', nodeId: 'node-a' })]).finished).toEqual([])
  })

  test('a mode shows its provider label, or its id when the provider does not list it', () => {
    const modes = [{ id: 'default', label: 'Always ask' }, { id: 'plan', label: 'Plan' }]
    expect(modeLabel('plan', modes)).toBe('Plan')
    expect(modeLabel('bypass', modes)).toBe('bypass')
    expect(modeLabel('plan', null)).toBe('plan')
  })

  test('provider modes are read once per connection and read again after a daemon switch or a reconnection', async () => {
    const answers: Array<(providers: string[]) => void> = []
    const catalog = new ProviderCatalog(
      () =>
        new Promise((resolve) =>
          answers.push((ids) =>
            resolve({
              ok: true,
              providers: ids.map((id) => ({ id, label: id, available: true, status: 'ready', error: null, models: [], modes: [], defaultModeId: null }))
            })
          )
        )
    )
    const settle = async (ids: string[]) => {
      answers.at(-1)!(ids)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const listed = () => catalog.snapshot().providers.map((provider) => provider.id)

    catalog.observe({ state: 'connected', url: 'ws://a/ws' })
    catalog.load()
    catalog.load()
    await settle(['claude'])
    catalog.load()
    expect(answers).toHaveLength(1)
    expect(listed()).toEqual(['claude'])

    // The same daemon came back: read again.
    catalog.observe({ state: 'reconnecting', url: 'ws://a/ws' })
    catalog.observe({ state: 'connected', url: 'ws://a/ws' })
    catalog.load()
    expect(answers).toHaveLength(2)
    // A switch while that read is out makes its answer stale.
    catalog.observe({ state: 'connected', url: 'ws://b/ws' })
    catalog.load()
    expect(answers).toHaveLength(3)
    await settle(['codex'])
    answers[1](['claude'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(listed()).toEqual(['codex'])
    expect(catalog.snapshot().status).toBe('ready')
  })
})

test.describe('remembered conversation state', () => {
  test('outlives the mounted view, keeps the last answer it saw, and is dropped with its node', () => {
    const state = conversationState('node-remembered')
    expect(state.stale).toBe(true)
    state.setTimeline({ epoch: 'e1', items: [message('a', 'The answer'), tool('t', 'shell')], olderCursor: null })
    expect(state.stale).toBe(false)
    // A newer window without assistant text keeps the last answer known.
    state.setTimeline({ epoch: 'e1', items: [tool('u', 'read')], olderCursor: 'c1' })
    expect(lastAssistantExcerpt(state.lastAnswer ? [state.lastAnswer] : [], 100)).toBe('The answer')
    state.draft = 'unsent'
    expect(conversationState('node-remembered')).toBe(state)

    noteTimelineChanged('node-remembered')
    expect(state.stale).toBe(true)
    // Nodes never shown are not tracked.
    noteTimelineChanged('node-never-shown')

    forgetConversationState('node-remembered')
    const fresh = conversationState('node-remembered')
    expect(fresh).not.toBe(state)
    expect(fresh.draft).toBe('')
    expect(fresh.timeline).toBeNull()
  })

  test('sending clears only the text that was sent', () => {
    expect(remainingDraft('Hello', 'Hello')).toBe('')
    expect(remainingDraft('Hello\nand more typed meanwhile', 'Hello')).toBe('and more typed meanwhile')
    expect(remainingDraft('Replaced meanwhile', 'Hello')).toBe('Replaced meanwhile')
    expect(remainingDraft('', 'Hello')).toBe('')
  })
})
