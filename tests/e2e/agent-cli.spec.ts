import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { runCli } from '../../src/cli/runCli'
import { createControlServer, type ControlServer, type ControlServerInfo } from '../../src/main/control'
import type { Actor } from '../../src/shared/domain'
import { agentSeed, FakeAgentService, FakeGateway, noteSeed } from '../control-fakes'

const run = promisify(execFile)
const skillPath = resolve('resources/skills/spade-canvas/SKILL.md')
const builtCli = resolve('out/main/cli.js')

type World = {
  gateway: FakeGateway
  agents: FakeAgentService
  info: ControlServerInfo
  server: ControlServer
  lead: string
  helper: string
  sketch: string
  agentEnv: Record<string, string>
  userEnv: Record<string, string>
}

const servers: ControlServer[] = []
const directories: string[] = []

// Project "Alpha": the lead agent, its delegated sub-agent, and a note under the sub-agent.
async function world(): Promise<World> {
  const gateway = new FakeGateway()
  const agents = new FakeAgentService()
  gateway.addProject('alpha', 'Alpha')
  const lead = gateway.seedTree('alpha', agentSeed('agent-lead', 'Lead'))
  const helper = gateway.seed('alpha', {
    type: 'spawnChild',
    sourceNodeId: lead,
    node: { ...agentSeed('agent-helper', 'Helper'), collapsed: true },
    origin: 'delegated'
  })
  const sketch = gateway.seedChild('alpha', helper, noteSeed('Sketch'))
  agents.addRuntime({ projectId: 'alpha', nodeId: lead, agentId: 'agent-lead' })

  const dataDirectory = await mkdtemp(join(tmpdir(), 'spade-cli-'))
  directories.push(dataDirectory)
  const server = createControlServer({
    gateway,
    agentService: agents,
    entities: gateway.entities,
    dataDirectory,
    cliScriptPath: builtCli,
    executablePath: process.execPath,
    identityLookup: { timeoutMs: 200, intervalMs: 20 }
  })
  servers.push(server)
  const info = await server.start()
  const userEnv = { SPADE_CONTROL_FILE: info.controlFile }
  return { gateway, agents, info, server, lead, helper, sketch, userEnv, agentEnv: { ...userEnv, PASEO_AGENT_ID: 'agent-lead' } }
}

test.afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

// `stdin` is what the CLI reads when an argument is `-`; `stdinReads` counts how often it asked.
async function cli(argv: string[], env: Record<string, string | undefined>, options: { cwd?: string; stdin?: string } = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  let stdinReads = 0
  const code = await runCli(argv, env, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    cwd: options.cwd ?? '/work/alpha',
    skill: await readFile(skillPath, 'utf8'),
    readStdin: async () => {
      stdinReads += 1
      return options.stdin ?? ''
    }
  })
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), stdinReads }
}

async function json<Value>(argv: string[], env: Record<string, string | undefined>): Promise<Value> {
  const result = await cli([...argv, '--json'], env)
  expect(result.stderr).toBe('')
  expect(result.code).toBe(0)
  return JSON.parse(result.stdout) as Value
}

test('an agent reads its tree, spawns on itself and on a descendant, reparents, and every change is its own', async () => {
  const { gateway, lead, helper, sketch, agentEnv } = await world()
  const self: Actor = { kind: 'agent', nodeId: lead, agentId: 'agent-lead' }

  const tree = await cli(['tree'], agentEnv)
  expect(tree.code).toBe(0)
  expect(tree.stdout.split('\n')).toEqual([
    `${lead} · agent · Lead  ← you`,
    `  ${helper} · agent · Helper [collapsed]`,
    `    ${sketch} · note · Sketch`
  ])

  const finding = await json<{ nodeId: string }>(['spawn', 'note', '--title', 'Finding', '--body', 'Root cause'], agentEnv)
  expect(gateway.parentOf(finding.nodeId)).toBe(lead)
  expect(gateway.node(finding.nodeId)).toMatchObject({ title: 'Finding', config: { body: 'Root cause' } })

  const followUp = await json<{ nodeId: string }>(['spawn', 'note', '--parent', sketch, '--title', 'Follow-up'], agentEnv)
  expect(gateway.parentOf(followUp.nodeId)).toBe(sketch)

  const moved = await cli(['reparent', finding.nodeId, helper], agentEnv)
  expect(moved.code).toBe(0)
  expect(moved.stdout).toContain('ok: reparented')
  expect(gateway.parentOf(finding.nodeId)).toBe(helper)

  const activity = await json<{ items: Array<{ actor: Actor; command: string; nodeIds: string[] }> }>(
    ['activity', '--limit', '3'],
    agentEnv
  )
  expect(activity.items.map((entry) => [entry.command, entry.actor, entry.nodeIds[0]])).toEqual([
    ['reparent', self, finding.nodeId],
    ['spawnChild', self, followUp.nodeId],
    ['spawnChild', self, finding.nodeId]
  ])

  const readable = await cli(['activity', '--limit', '1'], agentEnv)
  expect(readable.stdout).toContain(`agent ${lead} · Moved "Finding" under "Helper"`)
})

test('a command naming a missing node exits non-zero with the reducer’s error and changes nothing', async () => {
  const { gateway, agentEnv } = await world()
  const before = gateway.canvas('alpha')

  const read = await cli(['node', 'ghost'], agentEnv)
  expect(read.code).toBe(1)
  expect(read.stderr).toBe('spade: unknown-node: Unknown node: ghost')

  const change = await cli(['spawn', 'note', '--parent', 'ghost', '--body', 'x'], agentEnv)
  expect(change.code).toBe(1)
  expect(change.stderr).toContain('unknown-node')

  const asJson = await cli(['reparent', 'ghost', '--root', '--json'], agentEnv)
  expect(asJson.code).toBe(1)
  expect(JSON.parse(asJson.stderr)).toEqual({ ok: false, error: { code: 'unknown-node', message: 'Unknown node: ghost' } })
  expect(gateway.canvas('alpha')).toBe(before)
})

test('usage mistakes exit 2 without contacting SPADE', async () => {
  const { gateway, agentEnv, lead } = await world()
  for (const argv of [
    ['reparent', lead],
    ['spawn', 'note', '--url', 'https://example.com'],
    ['spawn', 'webpage'],
    ['move', lead, 'left', '3'],
    ['tree', '--bogus'],
    ['frobnicate']
  ]) {
    const result = await cli(argv, agentEnv)
    expect(result.code, argv.join(' ')).toBe(2)
    expect(result.stderr, argv.join(' ')).toMatch(/^spade: /)
  }
  expect(gateway.executed).toEqual([])
})

test('typed spawn flags become the entity’s config', async () => {
  const { gateway, agentEnv } = await world()
  await json(['spawn', 'image', '--path', 'shots/a.png', '--caption', 'Before'], agentEnv)
  await json(['spawn', 'webpage', '--url', 'https://example.com', '--new-tree'], agentEnv)
  await json(['spawn', 'agent', '--prompt', 'Review src', '--model', 'sonnet'], agentEnv)
  await json(['spawn', 'note', '--config', '{"body":"raw"}', '--description', 'From JSON'], agentEnv)
  expect(gateway.executed.map((entry) => entry.command)).toMatchObject([
    { node: { entityType: 'image', config: { source: { kind: 'path', path: resolve('/work/alpha', 'shots/a.png') }, caption: 'Before' } } },
    { node: { entityType: 'webpage', config: { url: 'https://example.com' } }, target: { kind: 'new-tree' } },
    { node: { entityType: 'agent', config: { provider: 'claude', model: 'sonnet', mode: 'default', prompt: 'Review src' } } },
    { node: { entityType: 'note', config: { body: 'raw' }, shortDescription: 'From JSON' } }
  ])
})

test('json output parses and matches the human reading', async () => {
  const { lead, helper, agentEnv } = await world()
  const me = await json<{ node: { id: string }; project: { name: string }; childIds: string[] }>(['whoami'], agentEnv)
  expect(me).toMatchObject({ node: { id: lead }, project: { name: 'Alpha' }, childIds: [helper] })

  const human = await cli(['whoami'], agentEnv)
  expect(human.stdout).toContain(`You are agent node ${lead} · agent · Lead`)
  expect(human.stdout).toContain(`Children: ${helper}`)
})

test('without an agent identity the user names the project', async () => {
  const { userEnv, lead } = await world()
  const unscoped = await cli(['nodes'], userEnv)
  expect(unscoped.code).toBe(1)
  expect(unscoped.stderr).toContain('project-required')

  const scoped = await cli(['nodes', '--project', 'Alpha'], userEnv)
  expect(scoped.code).toBe(0)
  expect(scoped.stdout).toContain(`${lead} · agent · Lead`)

  const noSelf = await cli(['spawn', 'note', '--body', 'x', '--as-user'], userEnv)
  expect(noSelf.code).toBe(1)
  expect(noSelf.stderr).toContain('--parent')
})

test('without an agent identity a change is refused unless a person passes --as-user', async () => {
  const { gateway, userEnv, agentEnv, lead } = await world()
  const refused = await cli(['rename', lead, 'Renamed'], userEnv)
  expect(refused.code).toBe(1)
  expect(refused.stderr).toMatch(/^spade: identity-required: /)
  expect(refused.stderr).toContain('--as-user')
  expect(gateway.executed).toEqual([])

  const asUser = await cli(['rename', lead, 'Renamed', '--as-user'], userEnv)
  expect(asUser.code).toBe(0)
  expect(gateway.executed.at(-1)?.actor).toEqual({ kind: 'user' })
  expect(gateway.node(lead).title).toBe('Renamed')

  // An agent cannot pose as the user.
  const posing = await cli(['rename', lead, 'Mine', '--as-user'], agentEnv)
  expect(posing.code).toBe(1)
  expect(gateway.node(lead).title).toBe('Renamed')

  expect((await cli(['help'], {})).stdout).toContain('--as-user')
  expect((await cli(['skill'], {})).stdout).toContain('--as-user')
})

test('a "-" argument reads that free-text value from stdin, verbatim apart from one trailing newline', async () => {
  const { gateway, agents, agentEnv, lead, helper, sketch } = await world()
  // Text cmd.exe, PowerShell, or a shell would otherwise reinterpret.
  const tricky = `Say "hi" & echo pwned | more > out.txt %PATH% ^ $HOME \`x\` 'q'\nsecond line`

  const send = async (argv: string[], stdin: string) => {
    const result = await cli(argv, agentEnv, { stdin })
    expect(result.stderr, argv.join(' ')).toBe('')
    expect(result.code, argv.join(' ')).toBe(0)
    expect(result.stdinReads, argv.join(' ')).toBe(1)
  }

  await send(['rename', sketch, '-'], `${tricky}\n`)
  expect(gateway.node(sketch).title).toBe(tricky)

  await send(['describe', sketch, '-'], `${tricky}\r\n`)
  expect(gateway.node(sketch).shortDescription).toBe(tricky)

  await send(['edit', sketch, '--body', '-'], `${tricky}\n\n`)
  expect(gateway.node(sketch).config).toEqual({ body: `${tricky}\n` })

  await send(['edit', sketch, '--config', '-'], JSON.stringify({ body: tricky }))
  expect(gateway.node(sketch).config).toEqual({ body: tricky })

  await send(['connect', helper, sketch, '--label', '-'], tricky)
  expect(gateway.canvas('alpha').edges.at(-1)).toMatchObject({ relation: 'references', label: tricky })

  await send(['spawn', 'note', '--title', 'T', '--body', '-'], tricky)
  await send(['spawn', 'note', '--title', '-', '--body', 'B'], tricky)
  const notes = gateway.canvas('alpha').nodes.slice(-2)
  expect(notes.map((node) => [node.title, node.config])).toEqual([
    ['T', { body: tricky }],
    [tricky, { body: 'B' }]
  ])

  await send(['spawn', 'agent', '--prompt', '-', '--title', 'Reviewer'], tricky)
  await send(['spawn', 'note', '--config', '-'], JSON.stringify({ body: tricky }))
  expect(gateway.executed.slice(-2).map((entry) => entry.command)).toMatchObject([
    { node: { entityType: 'agent', title: 'Reviewer', config: { prompt: tricky } } },
    { node: { entityType: 'note', config: { body: tricky } } }
  ])

  await send(['prompt', lead, '-'], `${tricky}\n`)
  expect(agents.prompts.at(-1)?.text).toBe(tricky)
})

test('only one value per command can come from stdin, and a "-" among other words is literal', async () => {
  const { gateway, agentEnv, sketch } = await world()
  const twice = await cli(['spawn', 'note', '--title', '-', '--body', '-'], agentEnv, { stdin: 'x' })
  expect(twice.code).toBe(2)
  expect(twice.stderr).toContain('stdin')
  expect(twice.stdinReads).toBe(0)
  expect(gateway.executed).toEqual([])

  const literal = await cli(['rename', sketch, 'A', '-', 'B'], agentEnv, { stdin: 'unused' })
  expect(literal.code).toBe(0)
  expect(literal.stdinReads).toBe(0)
  expect(gateway.node(sketch).title).toBe('A - B')

  expect((await cli(['help'], {})).stdout).toContain('stdin')
  expect((await cli(['help', 'prompt'], {})).stdout).toContain('-')
  expect((await cli(['skill'], {})).stdout).toContain('stdin')
})

test('reports clearly when SPADE is not running or its discovery file is stale', async () => {
  const unset = await cli(['tree'], {})
  expect(unset.code).toBe(1)
  expect(unset.stderr).toContain('SPADE_CONTROL_FILE is not set')

  const missing = await cli(['tree'], { SPADE_CONTROL_FILE: join(tmpdir(), 'spade-missing', 'control.json') })
  expect(missing.code).toBe(1)
  expect(missing.stderr).toContain('SPADE is not running')

  const { server, info, agentEnv } = await world()
  const contents = await readFile(info.controlFile, 'utf8')
  await server.stop()
  const directory = await mkdtemp(join(tmpdir(), 'spade-stale-'))
  directories.push(directory)
  const stale = join(directory, 'control.json')
  await writeFile(stale, contents)
  const result = await cli(['tree'], { ...agentEnv, SPADE_CONTROL_FILE: stale })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('stale')
})

test('skill prints the bundled skill without contacting SPADE', async () => {
  const result = await cli(['skill'], {})
  expect(result.code).toBe(0)
  expect(result.stdout).toBe((await readFile(skillPath, 'utf8')).trimEnd())
  expect(result.stdout).toMatch(/^---\nname: spade-canvas\n/)
})

test('the built CLI runs under plain node and through the launcher shim, with the skill embedded', async () => {
  const help = await run(process.execPath, [builtCli, 'help'])
  expect(help.stdout).toContain('Usage: spade <command>')

  const skill = await run(process.execPath, [builtCli, 'skill'])
  expect(skill.stdout.trimEnd()).toBe((await readFile(skillPath, 'utf8')).trimEnd())

  const { agentEnv, info, lead, sketch, gateway } = await world()
  const whoami = await run(process.execPath, [builtCli, 'whoami', '--json'], { env: { ...process.env, ...agentEnv } })
  expect(JSON.parse(whoami.stdout).node.id).toBe(lead)

  if (process.platform !== 'win32') {
    const shimEnv = { ...process.env, SPADE_CONTROL_FILE: undefined, PASEO_AGENT_ID: 'agent-lead' }
    const throughShim = await run(info.shimPath, ['whoami', '--json'], { env: shimEnv })
    expect(JSON.parse(throughShim.stdout).node.id).toBe(lead)

    // Free text piped through the launcher reaches SPADE untouched.
    const title = `Quote " & | > %PATH% $HOME \`x\` 'q'`
    const piped = await runWithStdin(info.shimPath, ['rename', sketch, '-'], `${title}\n`, shimEnv)
    expect(piped.code).toBe(0)
    expect(gateway.node(sketch).title).toBe(title)
  }
})

function runWithStdin(
  command: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}
