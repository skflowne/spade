import { isAbsolute, resolve } from 'node:path'
import { PASEO_AGENT_ID_ENV, type MutationResult, type SpawnPlacement } from '../main/control/protocol'
import type { CanvasCommand } from '../shared/commands'
import { CliFailure, createRpcClient, readDiscovery, type RpcClient } from './client'
import {
  formatActivity,
  formatEdges,
  formatEntities,
  formatMutation,
  formatNode,
  formatNodes,
  formatProjects,
  formatProviders,
  formatSpawnedAgent,
  formatTree,
  formatWhoAmI
} from './format'

export type CliIo = {
  stdout(text: string): void
  stderr(text: string): void
  // Relative image paths resolve against this directory.
  cwd: string
  // The bundled skill text, printed by `spade skill`.
  skill: string
  // The whole of standard input, read when an argument is `-`.
  readStdin(): Promise<string>
}

type Options = Record<string, string | boolean | undefined>
type Args = { positionals: string[]; options: Options }
type Context = { args: Args; rpc: RpcClient; io: CliIo; print(human: string, json: unknown): void }

type Command = {
  usage: string
  summary: string
  details?: string
  // Flags this command accepts besides --json and --help; `true` means the flag takes a value.
  options?: Record<string, boolean>
  positionals: [min: number, max: number]
  // Runs without contacting SPADE.
  offline?: boolean
  // Free-text arguments that accept `-` for "read this value from stdin": these flags, and the words from
  // positional `rest` on when they are a single `-`.
  stdinText?: { flags?: readonly string[]; rest?: number }
  run(context: Context): Promise<void>
}

class UsageError extends Error {}

const PAGE_OPTIONS = { limit: true, cursor: true }
const PROJECT_OPTION = { project: true }

const CONFIG_FLAGS = ['body', 'path', 'asset', 'caption', 'url', 'prompt', 'provider', 'model', 'mode'] as const
const TYPED_FLAGS: Record<string, readonly string[]> = {
  note: ['body'],
  image: ['path', 'asset', 'caption'],
  webpage: ['url'],
  agent: ['prompt', 'provider', 'model', 'mode']
}

const COMMANDS: Record<string, Command> = {
  help: {
    usage: 'spade help [command]',
    summary: 'Show every command, or one command in detail',
    positionals: [0, 1],
    offline: true,
    async run({ args, io }) {
      io.stdout(args.positionals[0] ? commandHelp(args.positionals[0]) : overview())
    }
  },
  skill: {
    usage: 'spade skill',
    summary: 'Print the skill that teaches agents to use the SPADE canvas',
    positionals: [0, 0],
    offline: true,
    async run({ io }) {
      io.stdout(io.skill.trimEnd())
    }
  },
  whoami: {
    usage: 'spade whoami',
    summary: 'Who you are: your Paseo agent, its owner, your node when expanded, project, parent, children',
    positionals: [0, 0],
    async run({ rpc, print }) {
      const result = await rpc('whoami', {})
      print(formatWhoAmI(result), result)
    }
  },
  projects: {
    usage: 'spade projects',
    summary: 'List projects',
    positionals: [0, 0],
    async run({ rpc, print }) {
      const result = await rpc('projects', {})
      print(formatProjects(result), result)
    }
  },
  tree: {
    usage: 'spade tree [--root <node>] [--depth <n>] [--limit <n>] [--cursor <c>] [--project <p>]',
    summary: 'The canvas as indented trees: id · type · title [flags]',
    details:
      'Without --root, lists every tree of the project. Nodes at the depth limit (default 6) show how many descendants are not listed.',
    options: { root: true, depth: true, ...PAGE_OPTIONS, ...PROJECT_OPTION },
    positionals: [0, 0],
    async run({ args, rpc, print }) {
      const result = await rpc('tree', {
        ...project(args),
        ...page(args),
        ...(args.options.root === undefined ? {} : { rootNodeId: text(args, 'root') }),
        ...(args.options.depth === undefined ? {} : { depth: integer(args, 'depth') })
      })
      print(formatTree(result), result)
    }
  },
  nodes: {
    usage: 'spade nodes [--type <entity>] [--limit <n>] [--cursor <c>] [--project <p>]',
    summary: 'List nodes, optionally of one entity type',
    options: { type: true, ...PAGE_OPTIONS, ...PROJECT_OPTION },
    positionals: [0, 0],
    async run({ args, rpc, print }) {
      const result = await rpc('nodes', {
        ...project(args),
        ...page(args),
        ...(args.options.type === undefined ? {} : { type: text(args, 'type') })
      })
      print(formatNodes(result), result)
    }
  },
  node: {
    usage: 'spade node <node>',
    summary: 'One node: state, parent, children, references, context projection, agent status',
    positionals: [1, 1],
    async run({ args, rpc, print }) {
      const result = await rpc('node', { nodeId: args.positionals[0] })
      print(formatNode(result), result)
    }
  },
  edges: {
    usage: 'spade edges [--node <node>] [--relation child|references] [--limit <n>] [--cursor <c>] [--project <p>]',
    summary: 'List edges, optionally touching one node or of one relation',
    options: { node: true, relation: true, ...PAGE_OPTIONS, ...PROJECT_OPTION },
    positionals: [0, 0],
    async run({ args, rpc, print }) {
      const relation = args.options.relation === undefined ? undefined : text(args, 'relation')
      if (relation !== undefined && relation !== 'child' && relation !== 'references') {
        throw new UsageError('--relation must be child or references')
      }
      const result = await rpc('edges', {
        ...project(args),
        ...page(args),
        ...(args.options.node === undefined ? {} : { nodeId: text(args, 'node') }),
        ...(relation === undefined ? {} : { relation })
      })
      print(formatEdges(result), result)
    }
  },
  activity: {
    usage: 'spade activity [--limit <n>] [--cursor <c>] [--project <p>]',
    summary: 'Who changed what, newest first',
    options: { ...PAGE_OPTIONS, ...PROJECT_OPTION },
    positionals: [0, 0],
    async run({ args, rpc, print }) {
      const result = await rpc('activity', { ...project(args), ...page(args) })
      print(formatActivity(result), result)
    }
  },
  entities: {
    usage: 'spade entities',
    summary: 'Registered node types and their config fields',
    positionals: [0, 0],
    async run({ rpc, print }) {
      const result = await rpc('entities', {})
      print(formatEntities(result), result)
    }
  },
  providers: {
    usage: 'spade providers',
    summary: 'Agent providers with their models and modes (* marks defaults)',
    positionals: [0, 0],
    async run({ rpc, print }) {
      const result = await rpc('providers', {})
      print(formatProviders(result), result)
    }
  },
  spawn: {
    usage:
      'spade spawn <type> [config flags | --config <json>] [--title <t>] [--description <d>] [--parent <node> | --tree <node> | --new-tree] [--project <p>]',
    summary: 'Create a node (only when the user asks for one), or start a Paseo agent you own',
    details: [
      'Target of a node (default: a child of your own node, or of your nearest expanded owner’s while you are',
      'collapsed into its list):',
      '  --parent <node>   child of any node, e.g. one below you to continue a branch',
      '  --tree <node>     child of the root of that node’s tree',
      '  --new-tree        a new root (in your project, or --project)',
      'Config flags by type:',
      '  note     --body <text>',
      '  image    --path <file> | --asset <id>  [--caption <text>]',
      '  webpage  --url <http(s) url>',
      '  agent    --prompt <text> [--provider <id>] [--model <id>] [--mode <id>]',
      '  any      --config <json>',
      'An agent is not a node: `spade spawn agent` starts a Paseo agent owned by you, exactly as Paseo’s own',
      'tools do, and prints its Paseo id; it is listed under you. It takes --title but no target, --description,',
      'or --project. Without --provider the user’s saved default provider (and its model) applies; see',
      '`spade providers`. An unset --model or --mode is left to Paseo. Message other agents with Paseo’s tools.'
    ].join('\n'),
    stdinText: { flags: ['body', 'prompt', 'caption', 'title', 'description', 'config'] },
    options: {
      ...Object.fromEntries(CONFIG_FLAGS.map((flag) => [flag, true])),
      config: true,
      title: true,
      description: true,
      parent: true,
      tree: true,
      'new-tree': false,
      ...PROJECT_OPTION
    },
    positionals: [1, 1],
    async run({ args, rpc, print, io }) {
      const entityType = args.positionals[0]
      const title = args.options.title === undefined ? {} : { title: text(args, 'title') }
      if (entityType === 'agent') {
        const misplaced = ['parent', 'tree', 'new-tree', 'description', 'project'].find((flag) => args.options[flag] !== undefined)
        if (misplaced) throw new UsageError(`--${misplaced} does not apply to an agent: it is listed under you, not placed on the canvas`)
        const result = await rpc('spawn', { entityType, config: spawnConfig(entityType, args, io.cwd), ...title })
        print('agentId' in result ? formatSpawnedAgent(result) : formatMutation('spawned agent', result), result)
        return
      }
      const result = await rpc('spawn', {
        ...project(args),
        entityType,
        config: spawnConfig(entityType, args, io.cwd),
        placement: placement(args),
        ...title,
        ...(args.options.description === undefined ? {} : { description: text(args, 'description') })
      })
      print('agentId' in result ? formatSpawnedAgent(result) : formatMutation(`spawned ${entityType}`, result), result)
    }
  },
  reparent: {
    usage: 'spade reparent <node> (<new-parent> | --root)',
    summary: 'Move a node and its whole branch under another node, or make it a root',
    options: { root: false },
    positionals: [1, 2],
    async run(context) {
      const [nodeId, parentId] = context.args.positionals
      if ((parentId === undefined) === (context.args.options.root !== true)) {
        throw new UsageError('Name a new parent or pass --root, not both')
      }
      await execute(context, 'reparented', { type: 'reparent', nodeId, newParentId: parentId ?? null })
    }
  },
  move: {
    usage: 'spade move <node> <x> <y>',
    summary: 'Set a node’s canvas position',
    positionals: [3, 3],
    async run(context) {
      const [nodeId, x, y] = context.args.positionals
      await execute(context, 'moved', { type: 'moveNodes', moves: [{ nodeId, position: { x: number(x), y: number(y) } }] })
    }
  },
  resize: {
    usage: 'spade resize <node> <width> <height>',
    summary: 'Set a node’s size',
    positionals: [3, 3],
    async run(context) {
      const [nodeId, width, height] = context.args.positionals
      await execute(context, 'resized', { type: 'resizeNode', nodeId, size: { width: number(width), height: number(height) } })
    }
  },
  rename: {
    usage: 'spade rename <node> (<title…> | -)',
    summary: 'Set a node’s title',
    positionals: [2, Infinity],
    stdinText: { rest: 1 },
    async run(context) {
      const [nodeId, ...words] = context.args.positionals
      await execute(context, 'renamed', { type: 'updateNode', nodeId, patch: { title: words.join(' ') } })
    }
  },
  describe: {
    usage: 'spade describe <node> (<description…> | - | --clear)',
    summary: 'Set or clear a node’s short description',
    options: { clear: false },
    positionals: [1, Infinity],
    stdinText: { rest: 1 },
    async run(context) {
      const [nodeId, ...words] = context.args.positionals
      if ((words.length === 0) === (context.args.options.clear !== true)) {
        throw new UsageError('Give a description or pass --clear, not both')
      }
      const shortDescription = words.length ? words.join(' ') : null
      await execute(context, 'described', { type: 'updateNode', nodeId, patch: { shortDescription } })
    }
  },
  edit: {
    usage: 'spade edit <node> (--body <text> | --config <json>)',
    summary: 'Replace a node’s config: a note’s body, or any type’s full config',
    options: { body: true, config: true },
    stdinText: { flags: ['body', 'config'] },
    positionals: [1, 1],
    async run(context) {
      const { options } = context.args
      if ((options.body === undefined) === (options.config === undefined)) {
        throw new UsageError('Pass exactly one of --body or --config')
      }
      const config = options.body !== undefined ? { body: String(options.body) } : json(context.args, 'config')
      await execute(context, 'edited', { type: 'updateNode', nodeId: context.args.positionals[0], patch: { config } })
    }
  },
  collapse: branchCommand('collapse', 'Collapse a node, or with --branch hide its descendants', 'collapseNode', 'collapseBranch'),
  expand: branchCommand('expand', 'Expand a node, or with --branch show its descendants', 'expandNode', 'expandBranch'),
  archive: branchCommand('archive', 'Archive a node, or with --branch the node and its descendants', 'archiveNode', 'archiveBranch'),
  restore: {
    usage: 'spade restore <node> [--branch]',
    summary: 'Un-archive a node, or with --branch the node and its descendants',
    options: { branch: false },
    positionals: [1, 1],
    async run(context) {
      const branch = context.args.options.branch === true
      await execute(context, 'restored', {
        type: 'restoreNode',
        nodeId: context.args.positionals[0],
        ...(branch ? { branch } : {})
      })
    }
  },
  remove: branchCommand(
    'remove',
    'Remove a node (children move up), or with --branch the whole branch; never touches files',
    'removeNode',
    'removeBranch'
  ),
  connect: {
    usage: 'spade connect <from> <to> [--label <text>]',
    summary: 'Add a references edge (never changes the tree)',
    options: { label: true },
    stdinText: { flags: ['label'] },
    positionals: [2, 2],
    async run(context) {
      const [fromNodeId, toNodeId] = context.args.positionals
      await execute(context, 'connected', {
        type: 'connectNodes',
        fromNodeId,
        toNodeId,
        ...(context.args.options.label === undefined ? {} : { label: text(context.args, 'label') })
      })
    }
  },
  disconnect: {
    usage: 'spade disconnect <edge>',
    summary: 'Remove a references edge',
    positionals: [1, 1],
    async run(context) {
      await execute(context, 'disconnected', { type: 'disconnectNodes', edgeId: context.args.positionals[0] })
    }
  }
}

function branchCommand(
  name: string,
  summary: string,
  single: 'collapseNode' | 'expandNode' | 'archiveNode' | 'removeNode',
  branch: 'collapseBranch' | 'expandBranch' | 'archiveBranch' | 'removeBranch'
): Command {
  return {
    usage: `spade ${name} <node> [--branch]`,
    summary,
    options: { branch: false },
    positionals: [1, 1],
    async run(context) {
      const type = context.args.options.branch === true ? branch : single
      await execute(context, `${name}${name.endsWith('e') ? 'd' : 'ed'}`, { type, nodeId: context.args.positionals[0] })
    }
  }
}

async function execute(context: Context, verb: string, command: CanvasCommand): Promise<void> {
  const result: MutationResult = await context.rpc('execute', { command })
  context.print(formatMutation(verb, result), result)
}

export async function runCli(argv: readonly string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const [name, ...rest] = argv
  if (name === undefined) {
    io.stderr(overview())
    return 2
  }
  if (name === '--help' || name === '-h') {
    io.stdout(overview())
    return 0
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
  if (!command) {
    io.stderr(`spade: unknown command "${name}". Run "spade help" for the list.`)
    return 2
  }

  let args: Args
  try {
    args = parseArgs(rest, command)
  } catch (error) {
    return usageFailure(io, name, error)
  }
  if (args.options.help === true) {
    io.stdout(commandHelp(name))
    return 0
  }
  const asJson = args.options.json === true

  try {
    args = await readStdinText(args, command, io)
  } catch (error) {
    return usageFailure(io, name, error)
  }

  try {
    const rpc: RpcClient = command.offline
      ? () => Promise.reject(new Error('offline command'))
      : createRpcClient(await readDiscovery(env), env[PASEO_AGENT_ID_ENV] || undefined)
    await command.run({
      args,
      rpc,
      io,
      print: (human, value) => io.stdout(asJson ? JSON.stringify(value, null, 2) : human)
    })
    return 0
  } catch (error) {
    if (error instanceof UsageError) return usageFailure(io, name, error)
    if (error instanceof CliFailure) {
      io.stderr(
        asJson
          ? JSON.stringify({ ok: false, error: error.error }, null, 2)
          : error.error.code === 'not-running'
            ? `spade: ${error.message}`
            : `spade: ${error.error.code}: ${error.message}`
      )
      return error.exitCode
    }
    io.stderr(`spade: internal: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

function usageFailure(io: CliIo, name: string, error: unknown): number {
  const message = error instanceof Error ? error.message : String(error)
  io.stderr(`spade: ${message}\nUsage: ${COMMANDS[name].usage}\nRun "spade help ${name}" for details.`)
  return 2
}

function parseArgs(tokens: readonly string[], command: Command): Args {
  const accepted: Record<string, boolean> = { json: false, help: false, ...command.options }
  const positionals: string[] = []
  const options: Options = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      positionals.push(...tokens.slice(index + 1))
      break
    }
    if (token === '-h') {
      options.help = true
      continue
    }
    if (!token.startsWith('--') || token === '-') {
      positionals.push(token)
      continue
    }
    const equals = token.indexOf('=')
    const flag = token.slice(2, equals === -1 ? undefined : equals)
    if (!Object.hasOwn(accepted, flag)) throw new UsageError(`unknown option --${flag}`)
    if (options[flag] !== undefined) throw new UsageError(`--${flag} given twice`)
    if (!accepted[flag]) {
      if (equals !== -1) throw new UsageError(`--${flag} takes no value`)
      options[flag] = true
      continue
    }
    if (equals !== -1) {
      options[flag] = token.slice(equals + 1)
    } else {
      if (index + 1 >= tokens.length) throw new UsageError(`--${flag} needs a value`)
      options[flag] = tokens[++index]
    }
  }
  if (options.help !== true) {
    const [min, max] = command.positionals
    if (positionals.length < min) throw new UsageError('missing arguments')
    if (positionals.length > max) throw new UsageError(`unexpected argument "${positionals[max]}"`)
  }
  return { positionals, options }
}

// One free-text value per invocation may be `-`; it is replaced by stdin without its final line break.
async function readStdinText(args: Args, command: Command, io: CliIo): Promise<Args> {
  const flags = (command.stdinText?.flags ?? []).filter((flag) => args.options[flag] === '-')
  const rest = command.stdinText?.rest
  const restFromStdin = rest !== undefined && args.positionals.length === rest + 1 && args.positionals[rest] === '-'
  const count = flags.length + (restFromStdin ? 1 : 0)
  if (count === 0) return args
  if (count > 1) throw new UsageError('only one value per command can come from stdin ("-")')
  const value = (await io.readStdin()).replace(/\r?\n$/, '')
  if (restFromStdin) return { ...args, positionals: [...args.positionals.slice(0, rest), value] }
  return { ...args, options: { ...args.options, [flags[0]]: value } }
}

function text(args: Args, flag: string): string {
  const value = args.options[flag]
  if (typeof value !== 'string' || value.length === 0) throw new UsageError(`--${flag} needs a value`)
  return value
}

function integer(args: Args, flag: string): number {
  const value = text(args, flag)
  if (!/^\d+$/.test(value)) throw new UsageError(`--${flag} must be a whole number`)
  return Number(value)
}

function number(value: string): number {
  const parsed = Number(value)
  if (value.trim() === '' || !Number.isFinite(parsed)) throw new UsageError(`"${value}" is not a number`)
  return parsed
}

function json(args: Args, flag: string): unknown {
  try {
    return JSON.parse(text(args, flag))
  } catch (error) {
    if (error instanceof UsageError) throw error
    throw new UsageError(`--${flag} must be valid JSON`)
  }
}

function project(args: Args): { project?: string } {
  return args.options.project === undefined ? {} : { project: text(args, 'project') }
}

function page(args: Args): { limit?: number; cursor?: string } {
  return {
    ...(args.options.limit === undefined ? {} : { limit: integer(args, 'limit') }),
    ...(args.options.cursor === undefined ? {} : { cursor: text(args, 'cursor') })
  }
}

function placement(args: Args): SpawnPlacement {
  const chosen = ['parent', 'tree', 'new-tree'].filter((flag) => args.options[flag] !== undefined)
  if (chosen.length > 1) throw new UsageError('Pass at most one of --parent, --tree, --new-tree')
  if (args.options.parent !== undefined) return { kind: 'child', parentNodeId: text(args, 'parent') }
  if (args.options.tree !== undefined) return { kind: 'tree', nodeId: text(args, 'tree') }
  if (args.options['new-tree'] === true) return { kind: 'new-tree' }
  return { kind: 'self' }
}

function spawnConfig(entityType: string, args: Args, cwd: string): unknown {
  const given = CONFIG_FLAGS.filter((flag) => args.options[flag] !== undefined)
  if (args.options.config !== undefined) {
    if (given.length) throw new UsageError(`--config replaces --${given[0]}; pass one or the other`)
    return json(args, 'config')
  }
  const allowed = TYPED_FLAGS[entityType]
  if (!allowed) throw new UsageError(`"${entityType}" has no config flags; pass --config <json> (see "spade entities")`)
  const stray = given.find((flag) => !allowed.includes(flag))
  if (stray) throw new UsageError(`--${stray} does not apply to ${entityType} (it takes ${allowed.map((flag) => `--${flag}`).join(', ')})`)
  const value = (flag: string): string | undefined => (args.options[flag] === undefined ? undefined : text(args, flag))

  switch (entityType) {
    case 'note':
      return { body: typeof args.options.body === 'string' ? args.options.body : '' }
    case 'webpage': {
      const url = value('url')
      if (url === undefined) throw new UsageError('a webpage needs --url')
      return { url }
    }
    case 'image': {
      const path = value('path')
      const asset = value('asset')
      if ((path === undefined) === (asset === undefined)) throw new UsageError('an image needs exactly one of --path or --asset')
      const caption = value('caption')
      return {
        source: path !== undefined ? { kind: 'path', path: isAbsolute(path) ? path : resolve(cwd, path) } : { kind: 'asset', assetId: asset },
        ...(caption === undefined ? {} : { caption })
      }
    }
    default: {
      const prompt = value('prompt')
      if (prompt === undefined) throw new UsageError('an agent needs --prompt')
      const config: Record<string, string> = { prompt }
      for (const flag of ['provider', 'model', 'mode']) {
        const setting = value(flag)
        if (setting !== undefined) config[flag] = setting
      }
      return config
    }
  }
}

function overview(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length))
  const lines = Object.entries(COMMANDS).map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`)
  return [
    'spade — read and change the SPADE canvas from an agent or a terminal.',
    '',
    'Usage: spade <command> [arguments] [--json]',
    '',
    ...lines,
    '',
    'Every command accepts --json for structured output and --help for details.',
    'Free text (rename, describe, edit, spawn --body/--prompt/--title/--description/--caption/--config,',
    'connect --label) can be "-" to read that one value from stdin: the safe way to pass arbitrary text,',
    'since no shell or cmd.exe re-reads it. Example: spade spawn note --title Findings --body - < findings.md',
    'Agents act as themselves, the Paseo agent named by PASEO_AGENT_ID, whether or not the canvas shows their',
    'own node; every change is attributed to them. Without PASEO_AGENT_ID the CLI only reads: the user changes',
    'the canvas in SPADE itself.'
  ].join('\n')
}

function commandHelp(name: string): string {
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
  if (!command) return `Unknown command "${name}". Run "spade help" for the list.`
  return [`Usage: ${command.usage}`, '', command.summary + '.', ...(command.details ? ['', command.details] : [])].join('\n')
}
