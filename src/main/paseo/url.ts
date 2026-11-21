import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const DEFAULT_PASEO_URL = 'ws://127.0.0.1:6767/ws'
export const PASEO_URL_ENV = 'SPADE_PASEO_URL'

export type PaseoUrlSource = 'setting' | 'environment' | 'local-daemon' | 'default'

export type PaseoUrlInputs = {
  // AppSettings.paseoUrl.
  setting?: string | null
  env?: Readonly<Record<string, string | undefined>>
  homeDir?: string
  // Returns null when the file is absent or unreadable.
  readFile?: (path: string) => string | null
}

// Picks the daemon URL: explicit setting, then SPADE_PASEO_URL, then the address the local daemon
// actually listens on, then Paseo's default. Values that are not a usable TCP address are skipped.
export function resolvePaseoUrl(inputs: PaseoUrlInputs = {}): { url: string; source: PaseoUrlSource } {
  const env = inputs.env ?? process.env
  const fromSetting = inputs.setting ? normalizePaseoUrl(inputs.setting) : null
  if (fromSetting) return { url: fromSetting, source: 'setting' }
  const fromEnv = env[PASEO_URL_ENV] ? normalizePaseoUrl(env[PASEO_URL_ENV]) : null
  if (fromEnv) return { url: fromEnv, source: 'environment' }
  const home = paseoHome(env, inputs.homeDir ?? homedir())
  const local = discoverLocalDaemonUrl(home, inputs.readFile ?? readTextFile)
  if (local) return { url: local, source: 'local-daemon' }
  return { url: DEFAULT_PASEO_URL, source: 'default' }
}

// The running daemon records its listen address in `paseo.pid`; `config.json` holds the configured one.
export function discoverLocalDaemonUrl(home: string, readFile: (path: string) => string | null): string | null {
  const pidListen = jsonField(readFile(join(home, 'paseo.pid')), ['listen'])
  const configListen = jsonField(readFile(join(home, 'config.json')), ['daemon', 'listen'])
  for (const listen of [pidListen, configListen]) {
    const url = listen ? normalizePaseoUrl(listen) : null
    if (url) return url
  }
  return null
}

// Accepts ws(s) URLs, `host:port`, `tcp://host:port`, or a bare port. Socket paths and pipes are not
// reachable over WebSocket from SPADE and yield null.
export function normalizePaseoUrl(value: string): string | null {
  const trimmed = value.trim()
  if (/^wss?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).protocol.startsWith('ws') ? trimmed : null
    } catch {
      return null
    }
  }
  if (/^\d{1,5}$/.test(trimmed)) return `ws://127.0.0.1:${trimmed}/ws`
  const hostPort = trimmed.replace(/^tcp:\/\//i, '')
  const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(hostPort)
  if (!match) return null
  // A wildcard listen address is reachable on loopback.
  const host = match[1] === '0.0.0.0' || match[1] === '[::]' ? '127.0.0.1' : match[1]
  return `ws://${host}:${match[2]}/ws`
}

function paseoHome(env: Readonly<Record<string, string | undefined>>, homeDir: string): string {
  const raw = env.PASEO_HOME?.trim() || '~/.paseo'
  if (raw === '~') return homeDir
  return raw.startsWith('~/') ? join(homeDir, raw.slice(2)) : resolve(raw)
}

function jsonField(text: string | null, path: string[]): string | null {
  if (!text) return null
  try {
    let value: unknown = JSON.parse(text)
    for (const key of path) value = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : null
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
