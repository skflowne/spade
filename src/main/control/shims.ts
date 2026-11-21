import { join } from 'node:path'
import { CONTROL_FILE_ENV, CONTROL_FILE_NAME } from './protocol'

// Launcher shims run the bundled CLI with the app's own executable in Node mode, so agents need no
// separate Node install. Everything lives in SPADE's data directory; nothing touches a project directory.

export type ControlPaths = {
  controlFile: string
  posixShim: string
  windowsShim: string
  // The shim agents on this platform invoke.
  shim: string
}

export type ShimTarget = { controlFile: string; executablePath: string; cliScriptPath: string }

export function controlPaths(dataDirectory: string, platform: NodeJS.Platform): ControlPaths {
  const posixShim = join(dataDirectory, 'bin', 'spade')
  const windowsShim = join(dataDirectory, 'bin', 'spade.cmd')
  return {
    controlFile: join(dataDirectory, CONTROL_FILE_NAME),
    posixShim,
    windowsShim,
    shim: platform === 'win32' ? windowsShim : posixShim
  }
}

export function posixShimScript(target: ShimTarget): string {
  return [
    '#!/bin/sh',
    '# Written by SPADE at every start.',
    `${CONTROL_FILE_ENV}=${shellQuote(target.controlFile)}`,
    `export ${CONTROL_FILE_ENV}`,
    'ELECTRON_RUN_AS_NODE=1',
    'export ELECTRON_RUN_AS_NODE',
    `exec ${shellQuote(target.executablePath)} ${shellQuote(target.cliScriptPath)} "$@"`,
    ''
  ].join('\n')
}

// `setlocal` keeps the variables out of the caller's cmd session. Inside double quotes only `%` is special
// in a batch file, and Windows paths cannot contain `"`.
export function windowsShimScript(target: ShimTarget): string {
  return [
    '@echo off',
    'setlocal',
    `set "${CONTROL_FILE_ENV}=${batchEscape(target.controlFile)}"`,
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"${batchEscape(target.executablePath)}" "${batchEscape(target.cliScriptPath)}" %*`,
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n')
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function batchEscape(value: string): string {
  return value.replace(/%/g, '%%')
}
