import { readFile } from 'node:fs/promises'
import {
  CONTROL_FILE_ENV,
  RPC_PATH,
  type ControlDiscovery,
  type ControlError,
  type RpcMethod,
  type RpcMethods,
  type RpcResponse
} from '../main/control/protocol'

// Finds the running SPADE app through its discovery file and calls its control server.

export class CliFailure extends Error {
  constructor(
    readonly error: ControlError | { code: 'not-running' | 'usage'; message: string },
    readonly exitCode: number
  ) {
    super(error.message)
  }
}

const REQUEST_TIMEOUT_MS = 120_000

function notRunning(message: string): CliFailure {
  return new CliFailure({ code: 'not-running', message }, 1)
}

export async function readDiscovery(env: Record<string, string | undefined>): Promise<ControlDiscovery & { file: string }> {
  const file = env[CONTROL_FILE_ENV]
  if (!file) {
    throw notRunning(
      `${CONTROL_FILE_ENV} is not set. Run the CLI through the launcher SPADE writes at startup into its data directory (bin/spade, or bin\\spade.cmd on Windows).`
    )
  }
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw notRunning(`SPADE is not running (no control file at ${file}). Start SPADE and retry.`)
  }
  let discovery: Partial<ControlDiscovery>
  try {
    discovery = JSON.parse(text) as Partial<ControlDiscovery>
  } catch {
    throw notRunning(`The control file at ${file} is unreadable. Restart SPADE and retry.`)
  }
  if (typeof discovery.url !== 'string' || typeof discovery.token !== 'string') {
    throw notRunning(`The control file at ${file} is incomplete. Restart SPADE and retry.`)
  }
  return {
    version: Number(discovery.version),
    url: discovery.url,
    token: discovery.token,
    pid: Number(discovery.pid),
    startedAt: String(discovery.startedAt),
    file
  }
}

export type RpcClient = <Method extends RpcMethod>(
  method: Method,
  params: RpcMethods[Method]['params']
) => Promise<RpcMethods[Method]['result']>

export function createRpcClient(
  discovery: ControlDiscovery & { file: string },
  identity: { agentId: string | undefined; asUser: boolean }
): RpcClient {
  const { agentId, asUser } = identity
  return async (method, params) => {
    let response: Response
    try {
      response = await fetch(new URL(RPC_PATH, discovery.url), {
        method: 'POST',
        headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ method, params, ...(agentId ? { agentId } : {}), ...(asUser ? { asUser: true } : {}) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw notRunning(`SPADE did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`)
      }
      throw notRunning(`SPADE is not running (the control file at ${discovery.file} is stale). Start SPADE and retry.`)
    }
    if (response.status === 401) {
      throw notRunning(`SPADE rejected the CLI's token; the control file at ${discovery.file} is stale. Restart SPADE.`)
    }
    let reply: RpcResponse<RpcMethods[typeof method]['result']>
    try {
      reply = (await response.json()) as RpcResponse<RpcMethods[typeof method]['result']>
    } catch {
      throw new CliFailure({ code: 'internal', message: `SPADE answered with HTTP ${response.status} and no JSON` }, 1)
    }
    if (!reply.ok) throw new CliFailure(reply.error, 1)
    return reply.result
  }
}
