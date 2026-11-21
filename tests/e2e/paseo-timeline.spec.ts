import { expect, test } from '@playwright/test'
import {
  CONVERSATION_FIELD_LIMIT,
  CONVERSATION_IMAGE_DATA_LIMIT,
  CONVERSATION_MESSAGE_TEXT_LIMIT,
  type ConversationItem
} from '../../src/shared/agents'
import { normalizeTimeline, type PaseoTimelineRow } from '../../src/main/paseo/normalizeTimeline'

// Item shapes captured from a Paseo 0.17 daemon (claude, codex, pi providers), trimmed and anonymized.
const TIMESTAMP = '2026-11-21T10:00:00.000Z'

function only(item: unknown): ConversationItem {
  const [normalized] = normalizeTimeline([{ item, timestamp: TIMESTAMP, seqStart: 7, seqEnd: 7 }], 'epoch-a')
  return normalized
}

type Case = { name: string; item: unknown; expected: Record<string, unknown> }

const cases: Case[] = [
  {
    name: 'user message',
    item: { type: 'user_message', text: 'Build the first version.', messageId: 'm-1', clientMessageId: 'c-1' },
    expected: { kind: 'user-message', text: 'Build the first version.', images: [], sender: null }
  },
  {
    name: 'prompt sent by another agent',
    item: {
      type: 'tool_call',
      callId: 'paseo-agent-message:m-2',
      agentMessage: {
        event: 'message',
        sender: { id: 'parent-agent', title: 'Validation root' },
        text: 'Create ok.txt, then reply OK.'
      },
      name: 'agent_message',
      status: 'completed',
      error: null,
      detail: { type: 'plain_text', text: 'Create ok.txt, then reply OK.', icon: 'bot' }
    },
    expected: {
      kind: 'user-message',
      text: 'Create ok.txt, then reply OK.',
      images: [],
      sender: { agentId: 'parent-agent', title: 'Validation root' }
    }
  },
  {
    name: 'assistant message',
    item: { type: 'assistant_message', text: '## Status\n\nAll green.', messageId: 'msg_1' },
    expected: { kind: 'assistant-message', text: '## Status\n\nAll green.', images: [] }
  },
  {
    name: 'reasoning',
    item: { type: 'reasoning', text: 'Looking around the repository first.\n\n' },
    expected: { kind: 'thinking', text: 'Looking around the repository first.\n\n' }
  },
  {
    name: 'claude shell call that failed with a tool_result error',
    item: {
      type: 'tool_call',
      callId: 'toolu_01',
      name: 'Bash',
      detail: { type: 'shell', command: 'git ls-files | head\necho done' },
      status: 'failed',
      error: { type: 'tool_result', content: 'Exit code 1\n.gitignore', is_error: true, tool_use_id: 'toolu_01' }
    },
    expected: {
      kind: 'tool-call',
      callId: 'toolu_01',
      toolKind: 'shell',
      name: 'Bash',
      status: 'failed',
      summary: 'git ls-files | head',
      input: 'git ls-files | head\necho done',
      output: null,
      error: 'Exit code 1\n.gitignore',
      diff: null,
      path: null,
      images: []
    }
  },
  {
    name: 'codex shell call with output and a non-zero exit code',
    item: {
      type: 'tool_call',
      callId: 'exec-1',
      name: 'shell',
      status: 'failed',
      error: { message: 'Tool call failed' },
      detail: { type: 'shell', command: 'rg -n Session src', cwd: '/work/app', output: 'src/a.ts:2: Session', exitCode: 2 }
    },
    expected: {
      toolKind: 'shell',
      status: 'failed',
      summary: 'rg -n Session src',
      output: 'src/a.ts:2: Session\n[exit code 2]',
      error: 'Tool call failed'
    }
  },
  {
    name: 'claude read call',
    item: {
      type: 'tool_call',
      callId: 'toolu_02',
      name: 'Read',
      detail: { type: 'read', filePath: '/work/app/docs/plan.md', content: '# Plan\n', offset: 1 },
      status: 'completed',
      error: null
    },
    expected: {
      toolKind: 'read',
      status: 'completed',
      summary: '/work/app/docs/plan.md',
      output: '# Plan\n',
      path: '/work/app/docs/plan.md',
      images: []
    }
  },
  {
    name: 'read of an absolute image path',
    item: {
      type: 'tool_call',
      callId: 'toolu_03',
      name: 'Read',
      detail: { type: 'read', filePath: 'C:\\work\\shots\\home.PNG' },
      status: 'completed',
      error: null
    },
    expected: { toolKind: 'read', path: 'C:\\work\\shots\\home.PNG', images: [{ source: 'C:\\work\\shots\\home.PNG', mimeType: 'image/png' }] }
  },
  {
    name: 'claude edit call with replaced and new text',
    item: {
      type: 'tool_call',
      callId: 'toolu_04',
      name: 'Edit',
      detail: {
        type: 'edit',
        filePath: '/work/app/src/a.ts',
        oldString: 'const a = 1\nconst b = 2\nconst c = 3',
        newString: 'const a = 1\nconst b = 20\nconst c = 3'
      },
      status: 'completed',
      error: null
    },
    expected: {
      toolKind: 'edit',
      summary: '/work/app/src/a.ts',
      path: '/work/app/src/a.ts',
      input: null,
      output: null,
      diff: [
        '--- a//work/app/src/a.ts',
        '+++ b//work/app/src/a.ts',
        '@@ -1,3 +1,3 @@',
        ' const a = 1',
        '-const b = 2',
        '+const b = 20',
        ' const c = 3'
      ].join('\n')
    }
  },
  {
    name: 'codex apply_patch edit with a provider diff',
    item: {
      type: 'tool_call',
      callId: 'exec-2',
      name: 'apply_patch',
      status: 'completed',
      error: null,
      detail: { type: 'edit', filePath: 'notes.md', newString: '# Notes\n', unifiedDiff: '@@ -0,0 +1 @@\n+# Notes' }
    },
    expected: { toolKind: 'edit', path: 'notes.md', diff: '@@ -0,0 +1 @@\n+# Notes' }
  },
  {
    name: 'claude write call',
    item: {
      type: 'tool_call',
      callId: 'toolu_05',
      name: 'Write',
      detail: { type: 'write', filePath: '/work/app/ok.txt', content: 'OK\nDONE' },
      status: 'completed',
      error: null
    },
    expected: {
      toolKind: 'edit',
      path: '/work/app/ok.txt',
      diff: '--- /dev/null\n+++ b//work/app/ok.txt\n@@ -0,0 +1,2 @@\n+OK\n+DONE'
    }
  },
  {
    name: 'web search',
    item: {
      type: 'tool_call',
      callId: 'toolu_06',
      name: 'WebSearch',
      detail: { type: 'search', query: 'resume template guidelines', toolName: 'web_search' },
      status: 'completed',
      error: null
    },
    expected: { toolKind: 'search', summary: 'resume template guidelines', input: 'resume template guidelines' }
  },
  {
    name: 'grep search with file results',
    item: {
      type: 'tool_call',
      callId: 'toolu_07',
      name: 'Grep',
      detail: { type: 'search', query: 'TODO', toolName: 'grep', filePaths: ['src/a.ts', 'src/b.ts'] },
      status: 'completed',
      error: null
    },
    expected: { toolKind: 'search', output: 'src/a.ts\nsrc/b.ts' }
  },
  {
    name: 'web fetch',
    item: {
      type: 'tool_call',
      callId: 'toolu_08',
      name: 'WebFetch',
      detail: { type: 'fetch', url: 'https://example.com/jobs/1', prompt: 'Return the posting.' },
      status: 'completed',
      error: null
    },
    expected: { toolKind: 'fetch', summary: 'https://example.com/jobs/1', input: 'Return the posting.', output: null }
  },
  {
    name: 'claude sub-agent launch',
    item: {
      type: 'tool_call',
      callId: 'toolu_09',
      name: 'Agent',
      detail: { type: 'sub_agent', subAgentType: 'general-purpose', description: 'S1 shared core', log: '', actions: [] },
      status: 'completed',
      error: null
    },
    expected: { callId: 'toolu_09', toolKind: 'subagent', summary: 'S1 shared core', input: 'S1 shared core', output: null }
  },
  {
    name: 'pi tool with an unknown detail and MCP-style output',
    item: {
      type: 'tool_call',
      callId: 'call_1|fc_1',
      name: 'subagent',
      status: 'completed',
      detail: {
        type: 'unknown',
        input: { action: 'list' },
        output: { content: [{ type: 'text', text: 'Executable agents:\n- delegate' }], details: { mode: 'management' } }
      },
      error: null
    },
    expected: {
      toolKind: 'other',
      summary: 'subagent {"action":"list"}',
      input: '{"action":"list"}',
      output: 'Executable agents:\n- delegate'
    }
  },
  {
    name: 'MCP tool output carrying an image',
    item: {
      type: 'tool_call',
      callId: 'call_2',
      name: 'browser_screenshot',
      status: 'completed',
      detail: {
        type: 'unknown',
        input: {},
        output: { content: [{ type: 'text', text: 'Captured.' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] }
      },
      error: null
    },
    expected: {
      output: 'Captured.',
      images: [{ source: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' }]
    }
  },
  {
    name: 'claude task notification',
    item: {
      type: 'tool_call',
      callId: 'task_notification_1',
      name: 'task_notification',
      detail: { type: 'plain_text', label: 'Create branch and typecheck', icon: 'wrench', text: 'Create branch and typecheck' },
      metadata: { synthetic: true, source: 'claude_task_notification', status: 'completed' },
      status: 'completed',
      error: null
    },
    expected: { toolKind: 'other', summary: 'Create branch and typecheck', output: 'Create branch and typecheck' }
  },
  {
    name: 'running tool call',
    item: {
      type: 'tool_call',
      callId: 'call_3',
      name: 'bash',
      status: 'running',
      detail: { type: 'shell', command: 'git fetch origin main' },
      error: null
    },
    expected: { toolKind: 'shell', status: 'running', output: null, error: null }
  },
  {
    name: 'todo list',
    item: {
      type: 'todo',
      items: [
        { text: 'Write tests', completed: true, status: 'completed' },
        { text: 'Implement', completed: false, status: 'in_progress' }
      ]
    },
    expected: { kind: 'todo', items: [{ text: 'Write tests', done: true }, { text: 'Implement', done: false }] }
  },
  {
    name: 'error item',
    item: { type: 'error', message: 'Provider exited.' },
    expected: { kind: 'error', message: 'Provider exited.' }
  },
  {
    name: 'warning notification',
    item: { type: 'notification', level: 'warning', message: 'Context almost full.' },
    expected: { kind: 'notice', text: 'Context almost full.' }
  },
  {
    name: 'error notification',
    item: { type: 'notification', level: 'error', message: 'Rate limited.' },
    expected: { kind: 'error', message: 'Rate limited.' }
  },
  {
    name: 'compaction',
    item: { type: 'compaction', status: 'completed' },
    expected: { kind: 'notice', text: 'Conversation compacted' }
  },
  {
    name: 'plugin item',
    item: { type: 'plugin', id: 'p-1', pluginId: 'acme', kind: 'card', version: 1, data: {} },
    expected: { kind: 'notice', text: 'Plugin item acme/card' }
  },
  {
    name: 'item type this client does not know',
    item: { type: 'hologram', payload: 1 },
    expected: { kind: 'notice', text: 'Unsupported timeline item “hologram”' }
  }
]

for (const { name, item, expected } of cases) {
  test(`normalizes a Paseo ${name}`, () => {
    expect(only(item)).toMatchObject({ id: 'epoch-a:7', timestamp: TIMESTAMP, ...expected })
  })
}

test('identifies items by epoch and first sequence, collapses re-reads, and orders oldest first', () => {
  const rows: PaseoTimelineRow[] = [
    { item: { type: 'assistant_message', text: 'second' }, timestamp: TIMESTAMP, seqStart: 9, seqEnd: 12 },
    { item: { type: 'user_message', text: 'first' }, timestamp: TIMESTAMP, seqStart: 3, seqEnd: 3 },
    { item: { type: 'assistant_message', text: 'second, grown' }, timestamp: TIMESTAMP, seqStart: 9, seqEnd: 14 }
  ]

  const items = normalizeTimeline(rows, 'epoch-b')

  expect(items.map(({ id }) => id)).toEqual(['epoch-b:3', 'epoch-b:9'])
  expect(items[1]).toMatchObject({ kind: 'assistant-message', text: 'second, grown' })
})

test('derives stable content identities when the daemon reports no sequence', () => {
  const rows: PaseoTimelineRow[] = [
    { item: { type: 'user_message', text: 'hello' }, timestamp: TIMESTAMP },
    { item: { type: 'assistant_message', text: 'hi' }, timestamp: '2026-11-21T10:00:01.000Z' }
  ]

  const first = normalizeTimeline(rows, null).map(({ id }) => id)
  const second = normalizeTimeline([...rows].reverse(), null).map(({ id }) => id)

  expect(new Set(first).size).toBe(2)
  expect(second).toEqual(first)
})

test('truncates oversized text with a visible marker inside the field bounds', () => {
  const message = only({ type: 'assistant_message', text: 'm'.repeat(CONVERSATION_MESSAGE_TEXT_LIMIT + 50) })
  const tool = only({
    type: 'tool_call',
    callId: 'c',
    name: 'Bash',
    status: 'completed',
    error: null,
    detail: { type: 'shell', command: 'cat big.log', output: 'o'.repeat(CONVERSATION_FIELD_LIMIT * 2) }
  })

  if (message.kind !== 'assistant-message' || tool.kind !== 'tool-call') throw new Error('unexpected kinds')
  expect(message.text.length).toBeLessThanOrEqual(CONVERSATION_MESSAGE_TEXT_LIMIT)
  expect(message.text).toMatch(/…\[truncated \d+ characters\]$/)
  expect(tool.output!.length).toBeLessThanOrEqual(CONVERSATION_FIELD_LIMIT)
  expect(tool.output).toMatch(/…\[truncated \d+ characters\]$/)
})

test('keeps tool summaries to one bounded line', () => {
  const tool = only({
    type: 'tool_call',
    callId: 'c',
    name: 'Bash',
    status: 'completed',
    error: null,
    detail: { type: 'shell', command: `   ${'x'.repeat(500)} \n second line` }
  })

  if (tool.kind !== 'tool-call') throw new Error('unexpected kind')
  expect(tool.summary).not.toContain('\n')
  expect(tool.summary.length).toBeLessThanOrEqual(240)
})

test('omits oversized inline images with a visible marker', () => {
  const tool = only({
    type: 'tool_call',
    callId: 'c',
    name: 'screenshot',
    status: 'completed',
    error: null,
    detail: {
      type: 'unknown',
      input: null,
      output: { content: [{ type: 'image', data: 'A'.repeat(CONVERSATION_IMAGE_DATA_LIMIT), mimeType: 'image/png' }] }
    }
  })

  if (tool.kind !== 'tool-call') throw new Error('unexpected kind')
  expect(tool.images).toEqual([])
  expect(tool.output).toContain('[image omitted:')
})
