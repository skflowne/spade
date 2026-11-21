import { crc32, deflateSync } from 'node:zlib'
import type { ElectronApplication } from '@playwright/test'
import type { AgentProviderInfo, AgentRuntime, AgentTimelinePage, ConversationItem } from '../../src/shared/agents'
import { SPADE_HOST_EVENTS } from '../../src/shared/ipc'

// Scripts the agent side of a real SPADE instance without Paseo: the main-process IPC handlers for agent
// requests are replaced from the test and agent events are pushed to the window, the same technique the
// UI specs use for the native folder picker. No production code knows about it.

type Reply = { ok: true; [key: string]: unknown } | { ok: false; error: { code: string; message: string } }
type ScriptedPage = Omit<AgentTimelinePage, 'nodeId'>

export type AgentCall = { method: string; args: unknown[] }
export type ShellCall = { method: 'showItemInFolder' | 'openPath' | 'openExternal'; target: string }

type ScriptState = {
  calls: AgentCall[]
  shellCalls: ShellCall[]
  providers: Reply
  // By node id; "*" answers for any node without its own entry.
  newest: Record<string, ScriptedPage>
  // By node id, then by cursor.
  older: Record<string, Record<string, ScriptedPage>>
  replies: Record<string, Reply>
  send(channel: string, payload: unknown): void
}

type ScriptGlobal = { __agentScript: ScriptState }

const UNREACHABLE: Reply = { ok: false, error: { code: 'paseo-unavailable', message: 'Paseo is unreachable.' } }

export async function installAgentScript(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow, ipcMain, shell }, { events, unreachable }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      const send = contents.send.bind(contents)
      const script: ScriptState = {
        calls: [],
        shellCalls: [],
        providers: unreachable,
        newest: {},
        older: {},
        replies: {},
        send
      }
      ;(globalThis as unknown as ScriptGlobal).__agentScript = script
      // The real agent service still runs (with Paseo disabled); only the test speaks for agents.
      contents.send = ((channel: string, ...args: unknown[]) => {
        if (channel === events.runtime || channel === events.timeline) return
        send(channel, ...args)
      }) as typeof contents.send

      const handle = (method: string, respond: (...args: unknown[]) => unknown): void => {
        ipcMain.removeHandler(`spade:${method}`)
        ipcMain.handle(`spade:${method}`, (_event, ...args: unknown[]) => {
          script.calls.push({ method, args })
          return respond(...args)
        })
      }
      handle('agents.listProviders', () => script.providers)
      handle('agents.getTimeline', (nodeId, query) => {
        const before = (query as { before?: string } | undefined)?.before
        const page = before ? script.older[nodeId as string]?.[before] : (script.newest[nodeId as string] ?? script.newest['*'])
        return page ? { ok: true, page: { nodeId, ...page } } : unreachable
      })
      for (const method of ['agents.prompt', 'agents.interrupt', 'agents.respondToPermission', 'agents.openProviderSubagent']) {
        handle(method, () => script.replies[method] ?? { ok: true })
      }

      shell.showItemInFolder = (path: string) => {
        script.shellCalls.push({ method: 'showItemInFolder', target: path })
      }
      shell.openPath = async (path: string) => {
        script.shellCalls.push({ method: 'openPath', target: path })
        return ''
      }
      shell.openExternal = async (url: string) => {
        script.shellCalls.push({ method: 'openExternal', target: url })
      }
    },
    { events: { runtime: SPADE_HOST_EVENTS.agentRuntime, timeline: SPADE_HOST_EVENTS.agentTimelineChanged }, unreachable: UNREACHABLE }
  )
}

export async function setProviders(app: ElectronApplication, reply: { providers: AgentProviderInfo[] } | 'unreachable'): Promise<void> {
  await app.evaluate((_electron, value) => {
    ;(globalThis as unknown as ScriptGlobal).__agentScript.providers = value
  }, reply === 'unreachable' ? UNREACHABLE : { ok: true as const, ...reply })
}

// Sets the newest page (and, when given, the older pages by cursor) and tells the window the timeline changed.
export async function setTimeline(
  app: ElectronApplication,
  nodeId: string,
  newest: ScriptedPage,
  older?: Record<string, ScriptedPage>
): Promise<void> {
  await app.evaluate(
    (_electron, { nodeId, newest, older, channel }) => {
      const script = (globalThis as unknown as ScriptGlobal).__agentScript
      script.newest[nodeId] = newest
      if (older) script.older[nodeId] = older
      if (nodeId !== '*') script.send(channel, { nodeId })
    },
    { nodeId, newest, older, channel: SPADE_HOST_EVENTS.agentTimelineChanged }
  )
}

export async function setReply(app: ElectronApplication, method: string, reply: Reply): Promise<void> {
  await app.evaluate(
    (_electron, { method, reply }) => {
      ;(globalThis as unknown as ScriptGlobal).__agentScript.replies[method] = reply
    },
    { method, reply }
  )
}

export async function pushRuntime(app: ElectronApplication, runtime: AgentRuntime): Promise<void> {
  await app.evaluate(
    (_electron, { runtime, channel }) => (globalThis as unknown as ScriptGlobal).__agentScript.send(channel, runtime),
    { runtime, channel: SPADE_HOST_EVENTS.agentRuntime }
  )
}

export async function agentCalls(app: ElectronApplication, method: string): Promise<unknown[][]> {
  return app.evaluate(
    (_electron, method) =>
      (globalThis as unknown as ScriptGlobal).__agentScript.calls.filter((call) => call.method === method).map((call) => call.args),
    method
  )
}

export async function shellCalls(app: ElectronApplication): Promise<ShellCall[]> {
  return app.evaluate(() => (globalThis as unknown as ScriptGlobal).__agentScript.shellCalls)
}

export function runtimeFor(projectId: string, nodeId: string, overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    projectId,
    nodeId,
    agentId: 'fake-1',
    resourceState: 'live',
    parentAgentId: null,
    provider: 'claude',
    model: 'opus',
    mode: 'default',
    title: null,
    status: 'idle',
    activity: 'idle',
    cwd: null,
    pendingPermissions: [],
    providerSubagents: [],
    lastError: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

const at = '2026-01-01T00:00:00.000Z'

export const items = {
  user: (id: string, text: string, sender: { agentId: string; title: string | null } | null = null): ConversationItem => ({
    id,
    timestamp: at,
    kind: 'user-message',
    text,
    images: [],
    sender
  }),
  assistant: (id: string, text: string): ConversationItem => ({ id, timestamp: at, kind: 'assistant-message', text, images: [] }),
  thinking: (id: string, text: string): ConversationItem => ({ id, timestamp: at, kind: 'thinking', text }),
  tool: (id: string, fields: Partial<Extract<ConversationItem, { kind: 'tool-call' }>>): ConversationItem => ({
    id,
    timestamp: at,
    kind: 'tool-call',
    callId: `call-${id}`,
    toolKind: 'other',
    name: 'tool',
    status: 'completed',
    summary: '',
    input: null,
    output: null,
    error: null,
    diff: null,
    path: null,
    images: [],
    ...fields
  }),
  todo: (id: string, entries: Array<{ text: string; done: boolean }>): ConversationItem => ({ id, timestamp: at, kind: 'todo', items: entries }),
  error: (id: string, message: string): ConversationItem => ({ id, timestamp: at, kind: 'error', message }),
  notice: (id: string, text: string): ConversationItem => ({ id, timestamp: at, kind: 'notice', text })
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

// A decodable RGBA PNG.
export function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const rows = Buffer.alloc(height * (1 + width * 4), 0x7f)
  for (let row = 0; row < height; row++) rows[row * (1 + width * 4)] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
