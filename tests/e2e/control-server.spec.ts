import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import {
  createControlServer,
  formatAgentInstructions,
  posixShimScript,
  powershellShimScript,
  windowsShimScript,
  type ControlServer,
  type ControlServerInfo
} from '../../src/main/control'
import { AgentServiceError } from '../../src/main/agents'
import { MAX_PAGE_LIMIT } from '../../src/main/control/protocol'
import type { Actor } from '../../src/shared/domain'
import { agentSeed, FakeAgentService, FakeGateway, noteSeed } from '../control-fakes'

const run = promisify(execFile)

type Reply = { status: number; body: { ok: boolean; result?: unknown; error?: { code: string; message: string } } }

function post(
  info: ControlServerInfo,
  payload: unknown,
  options: { token?: string | null; headers?: Record<string, string>; path?: string; method?: string } = {}
): Promise<Reply> {
  const url = new URL(info.url)
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const token = options.token === undefined ? info.token : options.token
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path: options.path ?? '/rpc',
        method: options.method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...options.headers
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : { ok: false } })
        })
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

async function call(info: ControlServerInfo, method: string, params: unknown = {}, agentId?: string) {
  const reply = await post(info, { method, params, ...(agentId === undefined ? {} : { agentId }) })
  return reply.body
}

async function ok<Result>(info: ControlServerInfo, method: string, params: unknown = {}, agentId?: string) {
  const body = await call(info, method, params, agentId)
  expect(body.error).toBeUndefined()
  return body.result as Result
}

type World = {
  gateway: FakeGateway
  agents: FakeAgentService
  server: ControlServer
  info: ControlServerInfo
  dataDirectory: string
  // Project "alpha": lead (agent, Paseo id agent-lead) -> plan (note) -> detail (note).
  lead: string
  plan: string
  detail: string
  // Project "beta": a single note tree.
  other: string
}

const servers: ControlServer[] = []
const directories: string[] = []

async function world(options: { maxBodyBytes?: number; identityTimeoutMs?: number } = {}): Promise<World> {
  const gateway = new FakeGateway()
  const agents = new FakeAgentService(gateway)
  gateway.addProject('alpha', 'Alpha')
  gateway.addProject('beta', 'Beta')
  const lead = gateway.seedTree('alpha', agentSeed('agent-lead', 'Lead'))
  const plan = gateway.seedChild('alpha', lead, noteSeed('Plan'))
  const detail = gateway.seedChild('alpha', plan, noteSeed('Detail'))
  const other = gateway.seedTree('beta', noteSeed('Other'))
  agents.addRuntime({ projectId: 'alpha', nodeId: lead, agentId: 'agent-lead', provider: 'codex', model: 'gpt', mode: 'auto' })

  const dataDirectory = await mkdtemp(join(tmpdir(), 'spade control '))
  directories.push(dataDirectory)
  const server = createControlServer({
    gateway,
    agentService: agents,
    entities: gateway.entities,
    dataDirectory,
    cliScriptPath: join(dataDirectory, 'cli.js'),
    executablePath: process.execPath,
    identityLookup: { timeoutMs: options.identityTimeoutMs ?? 400, intervalMs: 20 },
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes })
  })
  servers.push(server)
  const info = await server.start()
  return { gateway, agents, server, info, dataDirectory, lead, plan, detail, other }
}

test.afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

test.describe('transport', () => {
  test('rejects requests without the bearer token or with a wrong one', async () => {
    const { info } = await world()
    const missing = await post(info, { method: 'projects' }, { token: null })
    expect(missing.status).toBe(401)
    expect(missing.body.error?.code).toBe('unauthorized')

    const wrong = await post(info, { method: 'projects' }, { token: `${info.token.slice(0, -1)}x` })
    expect(wrong.status).toBe(401)

    const right = await post(info, { method: 'projects' })
    expect(right.status).toBe(200)
    expect(right.body.ok).toBe(true)
  })

  test('listens on the IPv4 loopback only and refuses foreign hosts and browser origins', async () => {
    const { info } = await world()
    expect(new URL(info.url).hostname).toBe('127.0.0.1')

    const rebound = await post(info, { method: 'projects' }, { headers: { host: 'evil.example:80' } })
    expect(rebound.status).toBe(403)
    expect(rebound.body.error?.code).toBe('forbidden')

    const browser = await post(info, { method: 'projects' }, { headers: { origin: 'https://evil.example' } })
    expect(browser.status).toBe(403)
  })

  test('refuses oversized bodies, malformed JSON, other paths, and unknown methods', async () => {
    const { info } = await world({ maxBodyBytes: 256 })
    const large = await post(info, { method: 'projects', params: { padding: 'x'.repeat(1_000) } })
    expect(large.status).toBe(413)
    expect(large.body.error?.code).toBe('payload-too-large')

    const malformed = await post(info, '{ not json')
    expect(malformed.status).toBe(400)
    expect(malformed.body.error?.code).toBe('bad-request')

    const elsewhere = await post(info, { method: 'projects' }, { path: '/admin' })
    expect(elsewhere.status).toBe(404)

    const unknown = await post(info, { method: 'dropTables' })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error?.code).toBe('unknown-method')
  })
})

test.describe('identity and attribution', () => {
  test('a Paseo agent id acts as that agent node, and the reducer records it as the actor', async () => {
    const { info, gateway, lead } = await world()
    const result = await ok<{ nodeId: string; projectId: string }>(
      info,
      'spawn',
      { entityType: 'note', config: { body: 'hello' }, title: 'Finding', placement: { kind: 'self' } },
      'agent-lead'
    )

    const actor: Actor = { kind: 'agent', nodeId: lead, agentId: 'agent-lead' }
    expect(result.projectId).toBe('alpha')
    expect(gateway.executed.at(-1)?.actor).toEqual(actor)
    expect(gateway.parentOf(result.nodeId)).toBe(lead)
    const entry = gateway.canvas('alpha').activity.at(-1)!
    expect(entry.actor).toEqual(actor)
    expect(entry.nodeIds).toContain(result.nodeId)
  })

  test('waits a bounded time for a just-created agent to be reported by Paseo', async () => {
    const { info, agents, lead } = await world()
    agents.locateMisses = 3
    const me = await ok<{ node: { id: string } }>(info, 'whoami', {}, 'agent-lead')
    expect(me.node.id).toBe(lead)
    expect(agents.locateCalls).toBe(4)
  })

  test('a collapsed child acts as itself, from its nearest expanded owner’s place, without a node of its own', async () => {
    const { info, gateway, agents, lead, plan } = await world()
    agents.locations.set('agent-child', {
      agentId: 'agent-child',
      parentAgentId: 'agent-lead',
      placements: [{ projectId: 'alpha', nodeId: null, anchorNodeId: lead }]
    })
    const actor: Actor = { kind: 'agent', nodeId: null, agentId: 'agent-child' }

    const me = await ok<Record<string, unknown>>(info, 'whoami', {}, 'agent-child')
    expect(me).toEqual({
      actor,
      project: { id: 'alpha', name: 'Alpha', rootPath: '/work/Alpha' },
      node: null,
      ownerAgentId: 'agent-lead',
      anchorNodeId: lead,
      childIds: []
    })
    const tree = await ok<{ projectId: string; selfNodeId: string | null }>(info, 'tree', {}, 'agent-child')
    expect(tree).toMatchObject({ projectId: 'alpha', selfNodeId: null })

    const finding = await ok<{ nodeId: string }>(
      info,
      'spawn',
      { entityType: 'note', config: { body: 'found it' }, placement: { kind: 'self' } },
      'agent-child'
    )
    expect(gateway.parentOf(finding.nodeId)).toBe(lead)
    const detail = await ok<{ nodeId: string }>(
      info,
      'spawn',
      { entityType: 'note', config: { body: 'more' }, placement: { kind: 'child', parentNodeId: plan } },
      'agent-child'
    )
    expect(gateway.parentOf(detail.nodeId)).toBe(plan)
    expect(gateway.executed.map((entry) => [entry.command, entry.actor])).toEqual([
      [expect.objectContaining({ type: 'spawnChild', sourceNodeId: lead }), actor],
      [expect.objectContaining({ type: 'spawnChild', sourceNodeId: lead }), actor]
    ])
    expect(gateway.canvas('alpha').activity.at(-1)?.actor).toEqual(actor)
  })

  test('an agent id Paseo does not place on any canvas fails after the bounded wait', async () => {
    const { info } = await world({ identityTimeoutMs: 150 })
    const started = Date.now()
    const body = await call(info, 'whoami', {}, 'agent-unknown')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe('unknown-agent')
    expect(body.error?.message).toContain('agent-unknown')
  })

  test('without an agent id reads are the user’s, who must name a project for project-wide reads', async () => {
    const { info } = await world()
    const me = await ok<{ actor: Actor; node: unknown }>(info, 'whoami')
    expect(me.actor).toEqual({ kind: 'user' })
    expect(me.node).toBeNull()

    const unscoped = await call(info, 'nodes')
    expect(unscoped.error?.code).toBe('project-required')
    const byName = await ok<{ projectId: string }>(info, 'nodes', { project: 'Alpha' })
    expect(byName.projectId).toBe('alpha')
  })

  test('a change without an agent identity is refused, and nobody can act as the user', async () => {
    const { info, gateway, agents, plan } = await world()
    const before = gateway.canvas('alpha')
    for (const [method, params] of [
      ['execute', { command: { type: 'collapseNode', nodeId: plan } }],
      ['spawn', { entityType: 'note', config: { body: 'x' }, placement: { kind: 'child', parentNodeId: plan } }],
      ['spawn', { entityType: 'agent', config: { prompt: 'Review', provider: 'claude' } }]
    ] as const) {
      const refused = await call(info, method, params)
      expect(refused.error?.code, method).toBe('identity-required')
      expect(refused.error?.message, method).toContain('PASEO_AGENT_ID')
      expect(refused.error?.message, method).not.toContain('--as-user')
    }

    // The old escape hatch is not part of the protocol, even posted directly.
    const asUser = await post(info, { method: 'execute', params: { command: { type: 'collapseNode', nodeId: plan } }, asUser: true })
    expect(asUser.status).toBe(400)
    expect(asUser.body.error?.code).toBe('bad-request')
    const both = await post(info, { method: 'execute', params: { command: { type: 'collapseNode', nodeId: plan } }, agentId: 'agent-lead', asUser: true })
    expect(both.body.error?.code).toBe('bad-request')
    expect(gateway.executed).toEqual([])
    expect(gateway.canvas('alpha')).toBe(before)
    expect(agents.spawned).toEqual([])
  })

  test('agents message each other through Paseo: there is no prompt method', async () => {
    const { info, lead } = await world()
    const reply = await post(info, { method: 'prompt', params: { nodeId: lead, text: 'status?' }, agentId: 'agent-lead' })
    expect(reply.status).toBe(400)
    expect(reply.body.error?.code).toBe('unknown-method')
  })

  test('every change method is attributed to the calling agent', async () => {
    const { info, gateway, lead, plan, detail } = await world()
    const actor: Actor = { kind: 'agent', nodeId: lead, agentId: 'agent-lead' }
    await ok(info, 'execute', { command: { type: 'reparent', nodeId: detail, newParentId: lead } }, 'agent-lead')
    await ok(info, 'execute', { command: { type: 'updateNode', nodeId: plan, patch: { title: 'Plan v2' } } }, 'agent-lead')
    await ok(info, 'execute', { command: { type: 'connectNodes', fromNodeId: plan, toNodeId: detail } }, 'agent-lead')

    expect(gateway.executed.map((entry) => entry.actor)).toEqual([actor, actor, actor])
    expect(gateway.canvas('alpha').activity.slice(-3).map((entry) => [entry.command, entry.actor])).toEqual([
      ['reparent', actor],
      ['updateNode', actor],
      ['connectNodes', actor]
    ])
  })
})

test.describe('commands', () => {
  test('a command naming a node runs in that node’s project, whoever calls', async () => {
    const { info, gateway, other } = await world()
    const result = await ok<{ projectId: string }>(
      info,
      'execute',
      { command: { type: 'updateNode', nodeId: other, patch: { title: 'Renamed' } } },
      'agent-lead'
    )
    expect(result.projectId).toBe('beta')
    expect(gateway.executed.at(-1)?.projectId).toBe('beta')
    expect(gateway.node(other).title).toBe('Renamed')
  })

  test('spawn targets: own node by default, a named parent, a tree root, or a new tree', async () => {
    const { info, gateway, lead, plan, detail, other } = await world()
    const spawn = (placement: unknown, extra: Record<string, unknown> = {}) =>
      ok<{ nodeId: string; projectId: string }>(
        info,
        'spawn',
        { entityType: 'note', config: { body: 'x' }, placement, ...extra },
        'agent-lead'
      )

    const underSelf = await spawn({ kind: 'self' })
    expect(gateway.parentOf(underSelf.nodeId)).toBe(lead)

    const underDetail = await spawn({ kind: 'child', parentNodeId: detail })
    expect(gateway.parentOf(underDetail.nodeId)).toBe(detail)

    const atRoot = await spawn({ kind: 'tree', nodeId: plan })
    expect(gateway.parentOf(atRoot.nodeId)).toBe(lead)

    const newTree = await spawn({ kind: 'new-tree' })
    expect(gateway.parentOf(newTree.nodeId)).toBeNull()
    expect(newTree.projectId).toBe('alpha')

    const elsewhere = await spawn({ kind: 'child', parentNodeId: other })
    expect(elsewhere.projectId).toBe('beta')
    expect(gateway.parentOf(elsewhere.nodeId)).toBe(other)

    const sameProject = gateway.executed.slice(0, 4)
    for (const entry of sameProject) {
      expect(entry.command).toMatchObject({ type: 'spawnChild', sourceNodeId: lead, origin: 'spawned' })
    }
  })

  test('spawning an agent forwards the request to Paseo with the caller as parent and creates no node', async () => {
    const { info, gateway, agents } = await world()
    const before = gateway.canvas('alpha')
    const started = await ok<Record<string, unknown>>(
      info,
      'spawn',
      { entityType: 'agent', config: { prompt: 'Review', provider: 'codex', model: 'gpt', mode: 'auto' }, title: 'Reviewer' },
      'agent-lead'
    )
    expect(started).toEqual({ agentId: 'paseo-child-1', ownerAgentId: 'agent-lead' })
    expect(agents.spawned).toEqual([
      { callerAgentId: 'agent-lead', input: { prompt: 'Review', provider: 'codex', model: 'gpt', mode: 'auto', title: 'Reviewer' } }
    ])
    expect(gateway.executed).toEqual([])
    expect(gateway.canvas('alpha')).toBe(before)

    // A child collapsed into its owner's list spawns its own children the same way.
    agents.locations.set('agent-child', {
      agentId: 'agent-child',
      parentAgentId: 'agent-lead',
      placements: [{ projectId: 'alpha', nodeId: null, anchorNodeId: 'unused' }]
    })
    await ok(info, 'spawn', { entityType: 'agent', config: { prompt: 'Dig', provider: 'claude' } }, 'agent-child')
    expect(agents.spawned.at(-1)).toEqual({ callerAgentId: 'agent-child', input: { prompt: 'Dig', provider: 'claude' } })
  })

  test('an agent spawn without a provider uses the user’s saved default provider and its model, never its mode; a named provider gets no model', async () => {
    const { info, gateway, agents } = await world()
    const spawn = (config: Record<string, unknown>) => call(info, 'spawn', { entityType: 'agent', config }, 'agent-lead')

    const refused = await spawn({ prompt: 'Review' })
    expect(refused.error?.code).toBe('invalid-params')
    expect(refused.error?.message).toContain('--provider')
    expect(refused.error?.message).toContain('spade providers')
    expect(agents.spawned).toEqual([])

    gateway.settings = { ...gateway.settings, agentDefaults: { provider: 'claude', model: 'opus', mode: 'plan' } }
    await spawn({ prompt: 'Review' })
    await spawn({ prompt: 'Review', provider: 'claude' })
    await spawn({ prompt: 'Review', provider: 'codex' })
    await spawn({ prompt: 'Review', model: 'sonnet', mode: null })
    expect(agents.spawned.map((entry) => entry.input)).toEqual([
      { prompt: 'Review', provider: 'claude', model: 'opus' },
      // Named by the caller, even the saved provider: Paseo picks the model.
      { prompt: 'Review', provider: 'claude' },
      { prompt: 'Review', provider: 'codex' },
      { prompt: 'Review', provider: 'claude', model: 'sonnet' }
    ])
  })

  test('an agent is not placed on the canvas: tree targets, a description, or a project are refused', async () => {
    const { info, agents, plan } = await world()
    for (const extra of [
      { placement: { kind: 'self' } },
      { placement: { kind: 'child', parentNodeId: plan } },
      { placement: { kind: 'tree', nodeId: plan } },
      { placement: { kind: 'new-tree' } },
      { description: 'Reviews' },
      { project: 'Alpha' }
    ]) {
      const reply = await call(info, 'spawn', { entityType: 'agent', config: { prompt: 'Review', provider: 'claude' }, ...extra }, 'agent-lead')
      expect(reply.error?.code, JSON.stringify(extra)).toBe('invalid-params')
    }
    for (const config of [{ provider: 'claude' }, { prompt: '', provider: 'claude' }, { prompt: 'x', provider: 'claude', cwd: '/tmp' }, 'Review']) {
      const reply = await call(info, 'spawn', { entityType: 'agent', config }, 'agent-lead')
      expect(reply.error?.code, JSON.stringify(config)).toBe('invalid-params')
    }
    expect(agents.spawned).toEqual([])
  })

  test('failures carry the reducer’s error codes and never fall back', async () => {
    const { info, gateway, lead, plan } = await world()
    const before = gateway.executed.length
    const missing = await call(info, 'execute', { command: { type: 'reparent', nodeId: 'ghost', newParentId: null } }, 'agent-lead')
    expect(missing.error).toEqual({ code: 'unknown-node', message: 'Unknown node: ghost' })

    const missingParent = await call(
      info,
      'spawn',
      { entityType: 'note', config: { body: 'x' }, placement: { kind: 'child', parentNodeId: 'ghost' } },
      'agent-lead'
    )
    expect(missingParent.error?.code).toBe('unknown-node')
    expect(gateway.executed.length).toBe(before)

    const cycle = await call(info, 'execute', { command: { type: 'reparent', nodeId: lead, newParentId: plan } }, 'agent-lead')
    expect(cycle.error?.code).toBe('cycle')

    const badConfig = await call(info, 'spawn', { entityType: 'webpage', config: { url: 'ftp://x' }, placement: { kind: 'self' } }, 'agent-lead')
    expect(badConfig.error?.code).toBe('invalid-config')

    const unknownType = await call(info, 'spawn', { entityType: 'teapot', config: {}, placement: { kind: 'self' } }, 'agent-lead')
    expect(unknownType.error?.code).toBe('unknown-entity-type')

    const missingEdge = await call(info, 'execute', { command: { type: 'disconnectNodes', edgeId: 'ghost-edge' } }, 'agent-lead')
    expect(missingEdge.error?.code).toBe('unknown-edge')
  })

  test('agent service failures keep their stable codes; anything else is internal', async () => {
    const { info, agents } = await world()
    agents.spawnFailure = new AgentServiceError('unknown-agent', 'Paseo has no agent agent-lead.')
    expect((await call(info, 'spawn', { entityType: 'agent', config: { prompt: 'Review', provider: 'claude' } }, 'agent-lead')).error).toEqual({
      code: 'unknown-agent',
      message: 'Paseo has no agent agent-lead.'
    })

    agents.providersFailure = new AgentServiceError('paseo-unavailable', 'Paseo is not connected (connecting).')
    expect((await call(info, 'providers')).error).toEqual({ code: 'paseo-unavailable', message: 'Paseo is not connected (connecting).' })

    for (const failure of [Object.assign(new Error('open failed'), { code: 'ENOENT' }), new Error('boom'), Object.assign(new Error('x'), { code: 42 })]) {
      agents.providersFailure = failure
      expect((await call(info, 'providers')).error?.code).toBe('internal')
    }
  })

  test('agents cannot move the viewport, forge resources, or bypass spawn', async () => {
    const { info, lead } = await world()
    const viewport = await call(info, 'execute', { command: { type: 'setViewport', viewport: { x: 0, y: 0, zoom: 1 } } }, 'agent-lead')
    expect(viewport.error?.code).toBe('invalid-command')

    const forged = await call(
      info,
      'execute',
      {
        command: {
          type: 'spawnChild',
          sourceNodeId: lead,
          origin: 'spawned',
          node: { ...agentSeed('agent-victim', 'Fake'), config: { provider: 'claude' } }
        }
      },
      'agent-lead'
    )
    expect(forged.error?.code).toBe('invalid-command')

    const extraField = await call(
      info,
      'spawn',
      { entityType: 'note', config: { body: 'x' }, placement: { kind: 'self' }, resourceRef: { provider: 'paseo' } },
      'agent-lead'
    )
    expect(extraField.error?.code).toBe('invalid-params')
  })
})

test.describe('reads', () => {
  test('whoami names the caller’s node, owner, project, parent, and children', async () => {
    const { info, lead, plan } = await world()
    const me = await ok<{
      node: { id: string; parentId: string | null }
      project: { name: string }
      ownerAgentId: string | null
      anchorNodeId: string
      childIds: string[]
    }>(info, 'whoami', {}, 'agent-lead')
    expect(me.node.id).toBe(lead)
    expect(me.node.parentId).toBeNull()
    expect(me.ownerAgentId).toBeNull()
    expect(me.anchorNodeId).toBe(lead)
    expect(me.project.name).toBe('Alpha')
    expect(me.childIds).toEqual([plan])
  })

  test('node lists, edges, and activity are paged and capped', async () => {
    const { info, gateway, lead } = await world()
    for (let index = 0; index < MAX_PAGE_LIMIT + 5; index += 1) gateway.seedChild('alpha', lead, noteSeed(`n${index}`))
    const total = gateway.canvas('alpha').nodes.length

    const first = await ok<{ items: Array<{ id: string }>; total: number; nextCursor: string }>(
      info,
      'nodes',
      { limit: 10 },
      'agent-lead'
    )
    expect(first.items).toHaveLength(10)
    expect(first.total).toBe(total)
    const second = await ok<{ items: Array<{ id: string }> }>(info, 'nodes', { limit: 10, cursor: first.nextCursor }, 'agent-lead')
    expect(second.items[0].id).toBe(gateway.canvas('alpha').nodes[10].id)

    const capped = await ok<{ items: unknown[] }>(info, 'nodes', { limit: 100_000 }, 'agent-lead')
    expect(capped.items).toHaveLength(MAX_PAGE_LIMIT)

    const notes = await ok<{ items: Array<{ type: string }> }>(info, 'nodes', { type: 'agent' }, 'agent-lead')
    expect(notes.items.map((item) => item.type)).toEqual(['agent'])

    const edges = await ok<{ items: unknown[]; nextCursor: string | null }>(info, 'edges', { limit: 5 }, 'agent-lead')
    expect(edges.items).toHaveLength(5)
    expect(edges.nextCursor).not.toBeNull()

    const activity = await ok<{ items: Array<{ summary: string }> }>(info, 'activity', { limit: 3 }, 'agent-lead')
    expect(activity.items).toHaveLength(3)
    expect(activity.items[0].summary).toBe(gateway.canvas('alpha').activity.at(-1)!.summary)

    const badCursor = await call(info, 'nodes', { cursor: 'abc' }, 'agent-lead')
    expect(badCursor.error?.code).toBe('invalid-params')
  })

  test('the tree is depth-limited and counts what it leaves out', async () => {
    const { info, lead, plan, detail } = await world()
    const tree = await ok<{ items: Array<{ id: string; depth: number; hiddenDescendants: number }>; selfNodeId: string }>(
      info,
      'tree',
      { depth: 1 },
      'agent-lead'
    )
    expect(tree.selfNodeId).toBe(lead)
    expect(tree.items.map((line) => [line.id, line.depth, line.hiddenDescendants])).toEqual([
      [lead, 0, 0],
      [plan, 1, 1]
    ])

    const branch = await ok<{ items: Array<{ id: string; depth: number }> }>(info, 'tree', { rootNodeId: plan }, 'agent-lead')
    expect(branch.items.map((line) => [line.id, line.depth])).toEqual([
      [plan, 0],
      [detail, 1]
    ])
  })

  test('node detail carries the bounded context projection and an agent’s runtime summary', async () => {
    const { info, gateway, lead, plan } = await world()
    gateway.seed('alpha', { type: 'updateNode', nodeId: plan, patch: { config: { body: 'y'.repeat(5_000) } } })
    const detail = await ok<{ context: { excerpt: string; node_id: string }; parentId: string; childIds: string[] }>(
      info,
      'node',
      { nodeId: plan },
      'agent-lead'
    )
    expect(detail.context.node_id).toBe(plan)
    expect(detail.context.excerpt.length).toBeLessThanOrEqual(1_200)
    expect(detail.parentId).toBe(lead)

    const agent = await ok<{ runtime: { activity: string; pendingPermissions: number; provider: string } }>(
      info,
      'node',
      { nodeId: lead }
    )
    expect(agent.runtime).toMatchObject({ activity: 'running', pendingPermissions: 0, provider: 'codex' })

    const missing = await call(info, 'node', { nodeId: 'ghost' })
    expect(missing.error?.code).toBe('unknown-node')
  })

  test('entities describe their config fields and providers come from the agent service', async () => {
    const { info } = await world()
    const entities = await ok<Array<{ type: string; config: string }>>(info, 'entities')
    expect(entities.map((entity) => entity.type)).toEqual(['note', 'agent', 'image', 'webpage'])
    expect(entities.find((entity) => entity.type === 'webpage')?.config).toContain('url')

    const providers = await ok<Array<{ id: string }>>(info, 'providers')
    expect(providers.map((provider) => provider.id)).toEqual(['claude'])
  })
})

test.describe('discovery and launcher shims', () => {
  test('writes the discovery file privately inside the data directory and removes it on stop', async () => {
    const { info, server, dataDirectory } = await world()
    const controlFile = join(dataDirectory, 'control.json')
    expect(info.controlFile).toBe(controlFile)
    const discovery = JSON.parse(await readFile(controlFile, 'utf8'))
    expect(discovery).toEqual({ version: 1, url: info.url, token: info.token, pid: process.pid, startedAt: expect.any(String) })
    if (process.platform !== 'win32') expect((await stat(controlFile)).mode & 0o777).toBe(0o600)
    expect((await readdir(dataDirectory)).sort()).toEqual(['bin', 'control.json'])
    expect((await readdir(join(dataDirectory, 'bin'))).sort()).toEqual(['spade', 'spade.cmd', 'spade.ps1'])

    await server.stop()
    expect(await readdir(dataDirectory)).toEqual(['bin'])

    const restarted = await server.start()
    expect(restarted.token).not.toBe(info.token)
    expect(JSON.parse(await readFile(controlFile, 'utf8')).token).toBe(restarted.token)
  })

  test('stop leaves a discovery file that another instance has since replaced', async () => {
    const { server, dataDirectory } = await world()
    const controlFile = join(dataDirectory, 'control.json')
    await writeFile(controlFile, JSON.stringify({ version: 1, url: 'http://127.0.0.1:1', token: 'other', pid: 1, startedAt: '' }))
    await server.stop()
    expect(JSON.parse(await readFile(controlFile, 'utf8')).token).toBe('other')
  })

  test('the POSIX shim runs the CLI script with the app executable in Node mode, paths with spaces and quotes intact', async () => {
    test.skip(process.platform === 'win32', 'POSIX shell shim')
    const dataDirectory = await mkdtemp(join(tmpdir(), "spade it's data "))
    directories.push(dataDirectory)
    const cliScriptPath = join(dataDirectory, "my cli's.mjs")
    await writeFile(
      cliScriptPath,
      'console.log(JSON.stringify({ argv: process.argv.slice(2), control: process.env.SPADE_CONTROL_FILE, node: process.env.ELECTRON_RUN_AS_NODE }))\n'
    )
    const server = createControlServer({
      gateway: new FakeGateway(),
      agentService: new FakeAgentService(null),
      entities: new FakeGateway().entities,
      dataDirectory,
      cliScriptPath,
      executablePath: process.execPath
    })
    servers.push(server)
    const info = await server.start()
    expect(info.shimPath).toBe(join(dataDirectory, 'bin', process.platform === 'win32' ? 'spade.cmd' : 'spade'))

    const { stdout } = await run(join(dataDirectory, 'bin', 'spade'), ['tree', '--title', "it's a $HOME `x`"])
    expect(JSON.parse(stdout)).toEqual({
      argv: ['tree', '--title', "it's a $HOME `x`"],
      control: join(dataDirectory, 'control.json'),
      node: '1'
    })
  })

  test('the Windows shim quotes every path and keeps its environment local', () => {
    const script = windowsShimScript({
      controlFile: 'C:\\Users\\A B\\AppData\\Roaming\\SPADE\\control.json',
      executablePath: 'C:\\Program Files\\R&D ^1\\SPADE.exe',
      cliScriptPath: 'C:\\Program Files\\SPADE\\resources\\app 100%\\out\\main\\cli.js'
    })
    expect(script.split('\r\n')).toEqual([
      '@echo off',
      'setlocal',
      'set "SPADE_CONTROL_FILE=C:\\Users\\A B\\AppData\\Roaming\\SPADE\\control.json"',
      'set "ELECTRON_RUN_AS_NODE=1"',
      // Inside double quotes `&` and `^` are literal in a batch file; only `%` needs doubling.
      '"C:\\Program Files\\R&D ^1\\SPADE.exe" "C:\\Program Files\\SPADE\\resources\\app 100%%\\out\\main\\cli.js" %*',
      'exit /b %ERRORLEVEL%',
      ''
    ])
  })

  test('the PowerShell launcher passes every path literally and restores the caller’s environment', () => {
    const script = powershellShimScript({
      controlFile: "C:\\Users\\O'Neil\\AppData\\Roaming\\SPADE\\control.json",
      executablePath: 'C:\\Program Files\\R&D ^1 $env:X `n\\SPADE.exe',
      cliScriptPath: 'C:\\Users\\Ann’s 100% "app"\\out\\main\\cli.js'
    })
    // A UTF-8 byte order mark, so Windows PowerShell 5.1 reads non-ASCII paths correctly.
    expect(script.startsWith('\uFEFF')).toBe(true)
    expect(script.slice(1).split('\r\n')).toEqual([
      '# Written by SPADE at every start.',
      '$spadePrevious = @($env:SPADE_CONTROL_FILE, $env:ELECTRON_RUN_AS_NODE)',
      'try {',
      "  $env:SPADE_CONTROL_FILE = 'C:\\Users\\O''Neil\\AppData\\Roaming\\SPADE\\control.json'",
      "  $env:ELECTRON_RUN_AS_NODE = '1'",
      // Single-quoted strings expand nothing; every quote character PowerShell accepts is doubled.
      "  & 'C:\\Program Files\\R&D ^1 $env:X `n\\SPADE.exe' 'C:\\Users\\Ann’’s 100% \"app\"\\out\\main\\cli.js' @args",
      '  $spadeExit = $LASTEXITCODE',
      '} finally {',
      '  $env:SPADE_CONTROL_FILE = $spadePrevious[0]',
      '  $env:ELECTRON_RUN_AS_NODE = $spadePrevious[1]',
      '}',
      'exit $spadeExit',
      ''
    ])
  })

  test('the POSIX launcher uses forward slashes for Windows paths, so Git Bash can run it', () => {
    const script = posixShimScript({
      controlFile: "C:\\Users\\O'Neil\\AppData\\Roaming\\SPADE\\control.json",
      executablePath: 'C:\\Program Files\\R&D 100% $HOME\\SPADE.exe',
      cliScriptPath: '\\\\server\\share\\SPADE\\cli.js'
    })
    expect(script.split('\n')).toEqual([
      '#!/bin/sh',
      '# Written by SPADE at every start.',
      "SPADE_CONTROL_FILE='C:/Users/O'\\''Neil/AppData/Roaming/SPADE/control.json'",
      'export SPADE_CONTROL_FILE',
      'ELECTRON_RUN_AS_NODE=1',
      'export ELECTRON_RUN_AS_NODE',
      "exec 'C:/Program Files/R&D 100% $HOME/SPADE.exe' '//server/share/SPADE/cli.js' \"$@\"",
      ''
    ])
    // POSIX paths, whose names may legally contain backslashes, are left alone.
    expect(posixShimScript({ controlFile: '/data/a\\b.json', executablePath: '/opt/spade', cliScriptPath: '/opt/cli.js' })).toContain(
      "SPADE_CONTROL_FILE='/data/a\\b.json'"
    )
  })
})

test.describe('agent instructions', () => {
  test('name the agent’s node and project and the quoted shim to run, without the skill itself', () => {
    const posix = formatAgentInstructions({
      nodeId: 'node-7',
      projectName: 'Alpha\nBeta',
      shims: {
        posixShim: '/home/me/.config/SPADE data/bin/spade',
        powershellShim: '/home/me/.config/SPADE data/bin/spade.ps1',
        windowsShim: '/home/me/.config/SPADE data/bin/spade.cmd'
      },
      platform: 'linux'
    })
    expect(posix).toContain('node-7')
    expect(posix).toContain('"Alpha Beta"')
    expect(posix).toContain("`'/home/me/.config/SPADE data/bin/spade' skill`")
    expect(posix.split('\n').length).toBeLessThanOrEqual(6)
    expect(posix).not.toContain('## ')
    // Agents change the canvas only when asked, and message each other through Paseo.
    expect(posix).toContain('only when the user asks')
    expect(posix).toContain('Paseo')
    expect(posix).not.toContain('--as-user')
    expect(posix).not.toContain('prompt')

    const windows = formatAgentInstructions({
      nodeId: 'node-7',
      projectName: 'Alpha',
      shims: {
        posixShim: "C:\\Users\\O'Neil B\\AppData\\Roaming\\SPADE\\bin\\spade",
        powershellShim: "C:\\Users\\O'Neil B\\AppData\\Roaming\\SPADE\\bin\\spade.ps1",
        windowsShim: "C:\\Users\\O'Neil B\\AppData\\Roaming\\SPADE\\bin\\spade.cmd"
      },
      platform: 'win32'
    })
    const bash = "'C:/Users/O'\\''Neil B/AppData/Roaming/SPADE/bin/spade'"
    const powershell = "& 'C:\\Users\\O''Neil B\\AppData\\Roaming\\SPADE\\bin\\spade.ps1'"
    const cmd = '"C:\\Users\\O\'Neil B\\AppData\\Roaming\\SPADE\\bin\\spade.cmd"'
    expect(windows).toContain('node-7')
    expect(windows).toContain(`\`${bash} skill\``)
    // Recommended in this order: bash-like shells, PowerShell, then cmd.exe with its warning.
    const order = [bash, powershell, cmd].map((command) => windows.indexOf(command))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    const cmdLine = windows.split('\n').find((line) => line.includes(cmd))!
    expect(cmdLine).toContain('cmd.exe')
    expect(cmdLine).toContain('stdin')
  })
})
