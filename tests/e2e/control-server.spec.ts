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
  windowsShimScript,
  type ControlServer,
  type ControlServerInfo
} from '../../src/main/control'
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
  const reply = await post(info, { method, params, ...(agentId ? { agentId } : {}) })
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
  const agents = new FakeAgentService()
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

  test('waits a bounded time for a just-created agent node to be reconciled', async () => {
    const { info, gateway, lead } = await world()
    gateway.resourceMisses = 3
    const me = await ok<{ node: { id: string } }>(info, 'whoami', {}, 'agent-lead')
    expect(me.node.id).toBe(lead)
    expect(gateway.resourceLookups).toBe(4)
  })

  test('an agent id with no canvas node fails after the bounded wait', async () => {
    const { info } = await world({ identityTimeoutMs: 150 })
    const started = Date.now()
    const body = await call(info, 'whoami', {}, 'agent-unknown')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe('unknown-agent')
    expect(body.error?.message).toContain('agent-unknown')
  })

  test('without an agent id the caller is the user, who must name a project for project-wide reads', async () => {
    const { info, gateway, plan } = await world()
    const me = await ok<{ actor: Actor; node: unknown }>(info, 'whoami')
    expect(me.actor).toEqual({ kind: 'user' })
    expect(me.node).toBeNull()

    const unscoped = await call(info, 'nodes')
    expect(unscoped.error?.code).toBe('project-required')
    const byName = await ok<{ projectId: string }>(info, 'nodes', { project: 'Alpha' })
    expect(byName.projectId).toBe('alpha')

    await ok(info, 'execute', { command: { type: 'collapseNode', nodeId: plan } })
    expect(gateway.executed.at(-1)?.actor).toEqual({ kind: 'user' })
  })

  test('every change method is attributed to the calling agent', async () => {
    const { info, gateway, agents, lead, plan, detail } = await world()
    const actor: Actor = { kind: 'agent', nodeId: lead, agentId: 'agent-lead' }
    await ok(info, 'execute', { command: { type: 'reparent', nodeId: detail, newParentId: lead } }, 'agent-lead')
    await ok(info, 'execute', { command: { type: 'updateNode', nodeId: plan, patch: { title: 'Plan v2' } } }, 'agent-lead')
    await ok(info, 'execute', { command: { type: 'connectNodes', fromNodeId: plan, toNodeId: detail } }, 'agent-lead')
    await ok(info, 'prompt', { nodeId: lead, text: 'status?' }, 'agent-lead')

    expect(gateway.executed.map((entry) => entry.actor)).toEqual([actor, actor, actor])
    expect(gateway.canvas('alpha').activity.slice(-3).map((entry) => [entry.command, entry.actor])).toEqual([
      ['reparent', actor],
      ['updateNode', actor],
      ['connectNodes', actor]
    ])
    expect(agents.prompts).toEqual([{ nodeId: lead, text: 'status?', actor }])
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

  test('a spawned agent inherits the caller’s provider, model, and mode unless overridden', async () => {
    const { info, gateway } = await world()
    await ok(info, 'spawn', { entityType: 'agent', config: { prompt: 'Review' }, placement: { kind: 'self' } }, 'agent-lead')
    expect(gateway.executed.at(-1)?.command).toMatchObject({
      node: { entityType: 'agent', config: { provider: 'codex', model: 'gpt', mode: 'auto', prompt: 'Review' } }
    })

    await ok(
      info,
      'spawn',
      { entityType: 'agent', config: { prompt: 'Draw', provider: 'claude' }, placement: { kind: 'self' } },
      'agent-lead'
    )
    expect(gateway.executed.at(-1)?.command).toMatchObject({
      node: { config: { provider: 'claude', model: null, mode: null, prompt: 'Draw' } }
    })
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

  test('prompting requires an agent node', async () => {
    const { info, plan } = await world()
    const body = await call(info, 'prompt', { nodeId: plan, text: 'hi' }, 'agent-lead')
    expect(body.error?.code).toBe('invalid-command')
  })
})

test.describe('reads', () => {
  test('whoami names the caller’s node, project, parent, and children', async () => {
    const { info, lead, plan } = await world()
    const me = await ok<{ node: { id: string; parentId: string | null }; project: { name: string }; childIds: string[] }>(
      info,
      'whoami',
      {},
      'agent-lead'
    )
    expect(me.node.id).toBe(lead)
    expect(me.node.parentId).toBeNull()
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
    expect((await readdir(join(dataDirectory, 'bin'))).sort()).toEqual(['spade', 'spade.cmd'])

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
      agentService: new FakeAgentService(),
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
      executablePath: 'C:\\Program Files\\SPADE\\SPADE.exe',
      cliScriptPath: 'C:\\Program Files\\SPADE\\resources\\app 100%\\out\\main\\cli.js'
    })
    expect(script.split('\r\n')).toEqual([
      '@echo off',
      'setlocal',
      'set "SPADE_CONTROL_FILE=C:\\Users\\A B\\AppData\\Roaming\\SPADE\\control.json"',
      'set "ELECTRON_RUN_AS_NODE=1"',
      '"C:\\Program Files\\SPADE\\SPADE.exe" "C:\\Program Files\\SPADE\\resources\\app 100%%\\out\\main\\cli.js" %*',
      'exit /b %ERRORLEVEL%',
      ''
    ])
  })
})

test.describe('agent instructions', () => {
  test('name the agent’s node and project and the quoted shim to run, without the skill itself', () => {
    const posix = formatAgentInstructions({
      nodeId: 'node-7',
      projectName: 'Alpha\nBeta',
      shimPath: "/home/me/.config/SPADE data/bin/spade",
      platform: 'linux'
    })
    expect(posix).toContain('node-7')
    expect(posix).toContain('"Alpha Beta"')
    expect(posix).toContain("`'/home/me/.config/SPADE data/bin/spade' skill`")
    expect(posix.split('\n').length).toBeLessThanOrEqual(6)
    expect(posix).not.toContain('## ')

    const windows = formatAgentInstructions({
      nodeId: 'node-7',
      projectName: 'Alpha',
      shimPath: 'C:\\Users\\A B\\AppData\\Roaming\\SPADE\\bin\\spade.cmd',
      platform: 'win32'
    })
    expect(windows).toContain('`"C:\\Users\\A B\\AppData\\Roaming\\SPADE\\bin\\spade.cmd" skill`')
    expect(windows).toContain('& "C:\\Users')
  })
})
