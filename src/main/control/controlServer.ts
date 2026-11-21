import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AgentService, WorkspaceGateway } from '../contracts'
import type { EntityRegistry } from '../../shared/entities'
import { removeDiscoveryFile, writeDiscoveryFile, writeFileAtomic } from './files'
import { createControlMethods, toControlError } from './methods'
import { CONTROL_PROTOCOL_VERSION, RPC_PATH, type ControlErrorCode, type RpcResponse } from './protocol'
import { controlPaths, posixShimScript, windowsShimScript, type ControlPaths } from './shims'

export type ControlServerOptions = {
  gateway: WorkspaceGateway
  agentService: AgentService
  entities: EntityRegistry
  // SPADE's own data directory (Electron `userData`). The discovery file and shims are written here only.
  dataDirectory: string
  // The bundled CLI entry, `out/main/cli.js` next to the main bundle.
  cliScriptPath: string
  // The executable the shims run in Node mode: `process.execPath` of the Electron app.
  executablePath: string
  platform?: NodeJS.Platform
  maxBodyBytes?: number
  identityLookup?: { timeoutMs: number; intervalMs: number }
}

export type ControlServerInfo = {
  url: string
  token: string
  controlFile: string
  // The shim agents on this platform invoke.
  shimPath: string
}

export type ControlServer = {
  readonly paths: ControlPaths
  // Same as `paths.shim`; known before `start`, so agent instructions can name it.
  readonly shimPath: string
  // Listens on 127.0.0.1 with an OS-assigned port, then writes the shims and the discovery file.
  start(): Promise<ControlServerInfo>
  // Closes every connection and removes the discovery file if it still names this server.
  stop(): Promise<void>
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_IDENTITY_LOOKUP = { timeoutMs: 5_000, intervalMs: 200 }
const LOOPBACK = '127.0.0.1'

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ControlErrorCode,
    message: string
  ) {
    super(message)
  }
}

export function createControlServer(options: ControlServerOptions): ControlServer {
  const platform = options.platform ?? process.platform
  const paths = controlPaths(options.dataDirectory, platform)
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const methods = createControlMethods({
    gateway: options.gateway,
    agentService: options.agentService,
    entities: options.entities,
    identityLookup: options.identityLookup ?? DEFAULT_IDENTITY_LOOKUP
  })

  let running: { server: Server; info: ControlServerInfo; tokenDigest: Buffer; port: number } | null = null

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const state = running
    if (!state) throw new HttpFailure(503, 'internal', 'SPADE is shutting down')

    const host = request.headers.host
    if (host !== `${LOOPBACK}:${state.port}` && host !== `localhost:${state.port}`) {
      throw new HttpFailure(403, 'forbidden', 'Requests must address the loopback control server directly')
    }
    if (request.headers.origin !== undefined) {
      throw new HttpFailure(403, 'forbidden', 'Browser requests are not accepted')
    }
    if (!authorized(request.headers.authorization, state.tokenDigest)) {
      throw new HttpFailure(401, 'unauthorized', 'Missing or wrong bearer token')
    }
    if (request.url !== RPC_PATH) throw new HttpFailure(404, 'not-found', `No endpoint ${request.url ?? ''}`)
    if (request.method !== 'POST') throw new HttpFailure(405, 'bad-request', 'Use POST')

    const body = await readBody(request, maxBodyBytes)
    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      throw new HttpFailure(400, 'bad-request', 'The body is not valid JSON')
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new HttpFailure(400, 'bad-request', 'The body must be an object { method, params, agentId? }')
    }
    const { method, params, agentId } = payload as Record<string, unknown>
    if (typeof method !== 'string' || !methods.has(method)) {
      throw new HttpFailure(400, 'unknown-method', `Unknown method: ${String(method)}`)
    }
    if (agentId !== undefined && (typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 256)) {
      throw new HttpFailure(400, 'bad-request', 'agentId must be a non-empty string')
    }

    let reply: RpcResponse
    try {
      reply = { ok: true, result: await methods.call(method, params, agentId) }
    } catch (error) {
      reply = { ok: false, error: toControlError(error) }
    }
    send(response, 200, reply)
  }

  async function stop(): Promise<void> {
    const state = running
    if (!state) return
    running = null
    await new Promise<void>((resolve) => {
      state.server.close(() => resolve())
      state.server.closeAllConnections()
    })
    await removeDiscoveryFile(paths.controlFile, state.info.token)
  }

  return {
    paths,
    shimPath: paths.shim,

    async start() {
      if (running) return running.info
      const token = randomBytes(32).toString('base64url')
      const server = createServer((request, response) => {
        handle(request, response).catch((error: unknown) => {
          const failure =
            error instanceof HttpFailure ? error : new HttpFailure(500, 'internal', error instanceof Error ? error.message : String(error))
          send(response, failure.status, { ok: false, error: { code: failure.code, message: failure.message } })
          if (failure.status === 413) response.on('finish', () => request.destroy())
        })
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, LOOPBACK, () => {
          server.off('error', reject)
          resolve()
        })
      })
      const port = (server.address() as AddressInfo).port
      const info: ControlServerInfo = {
        url: `http://${LOOPBACK}:${port}`,
        token,
        controlFile: paths.controlFile,
        shimPath: paths.shim
      }
      running = { server, info, tokenDigest: digest(token), port }

      try {
        const target = {
          controlFile: paths.controlFile,
          executablePath: options.executablePath,
          cliScriptPath: options.cliScriptPath
        }
        await writeFileAtomic(paths.posixShim, posixShimScript(target), 0o755)
        await writeFileAtomic(paths.windowsShim, windowsShimScript(target), 0o755)
        await writeDiscoveryFile(paths.controlFile, {
          version: CONTROL_PROTOCOL_VERSION,
          url: info.url,
          token,
          pid: process.pid,
          startedAt: new Date().toISOString()
        })
      } catch (error) {
        await stop()
        throw error
      }
      return info
    },

    stop
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

// Compares fixed-length digests so the comparison takes the same time whatever the presented token.
function authorized(header: string | undefined, tokenDigest: Buffer): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? '')
  return match !== null && timingSafeEqual(digest(match[1]), tokenDigest)
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(new HttpFailure(413, 'payload-too-large', `The body exceeds ${limit} bytes`))
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        request.removeAllListeners('data')
        request.removeAllListeners('end')
        reject(new HttpFailure(413, 'payload-too-large', `The body exceeds ${limit} bytes`))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...(status === 413 ? { connection: 'close' } : {})
  })
  response.end(text)
}
