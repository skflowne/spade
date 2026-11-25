import { join } from 'node:path'
import { CONTROL_FILE_ENV, CONTROL_FILE_NAME } from './protocol'

// Launcher shims run the bundled CLI with the app's own executable in Node mode, so agents need no
// separate Node install. Everything lives in SPADE's data directory; nothing touches a project directory.
// There is one launcher per shell family: `spade` for POSIX shells (Git Bash on Windows), `spade.ps1` for
// PowerShell, and `spade.cmd` for cmd.exe, which re-parses arguments and is the last resort.

export type ControlPaths = {
  controlFile: string
  posixShim: string
  powershellShim: string
  windowsShim: string
  // The shim a person at a terminal on this platform invokes.
  shim: string
}

export type ShimPaths = Pick<ControlPaths, 'posixShim' | 'powershellShim' | 'windowsShim'>

export type ShimTarget = { controlFile: string; executablePath: string; cliScriptPath: string }

export function controlPaths(dataDirectory: string, platform: NodeJS.Platform): ControlPaths {
  const posixShim = join(dataDirectory, 'bin', 'spade')
  const powershellShim = join(dataDirectory, 'bin', 'spade.ps1')
  const windowsShim = join(dataDirectory, 'bin', 'spade.cmd')
  return {
    controlFile: join(dataDirectory, CONTROL_FILE_NAME),
    posixShim,
    powershellShim,
    windowsShim,
    shim: platform === 'win32' ? windowsShim : posixShim
  }
}

export function posixShimScript(target: ShimTarget): string {
  return [
    '#!/bin/sh',
    '# Written by SPADE at every start.',
    `${CONTROL_FILE_ENV}=${shellQuote(posixPath(target.controlFile))}`,
    `export ${CONTROL_FILE_ENV}`,
    'ELECTRON_RUN_AS_NODE=1',
    'export ELECTRON_RUN_AS_NODE',
    `exec ${shellQuote(posixPath(target.executablePath))} ${shellQuote(posixPath(target.cliScriptPath))} "$@"`,
    ''
  ].join('\n')
}

// Runs in the caller's PowerShell session, so it restores the two variables it sets. Arguments go to the
// executable through `@args`, never through cmd.exe. The byte order mark makes Windows PowerShell 5.1 read
// the file as UTF-8 instead of the ANSI code page.
export function powershellShimScript(target: ShimTarget): string {
  return (
    '\uFEFF' +
    [
      '# Written by SPADE at every start.',
      `$spadePrevious = @($env:${CONTROL_FILE_ENV}, $env:ELECTRON_RUN_AS_NODE)`,
      'try {',
      `  $env:${CONTROL_FILE_ENV} = ${powershellQuote(target.controlFile)}`,
      "  $env:ELECTRON_RUN_AS_NODE = '1'",
      `  & ${powershellQuote(target.executablePath)} ${powershellQuote(target.cliScriptPath)} @args`,
      '  $spadeExit = $LASTEXITCODE',
      '} finally {',
      `  $env:${CONTROL_FILE_ENV} = $spadePrevious[0]`,
      '  $env:ELECTRON_RUN_AS_NODE = $spadePrevious[1]',
      '}',
      'exit $spadeExit',
      ''
    ].join('\r\n')
  )
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

// A single-quoted PowerShell string expands nothing. PowerShell also ends one at the typographic single
// quotes, so each quote character is doubled.
export function powershellQuote(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, (quote) => quote + quote)}'`
}

// Git Bash runs Windows executables by drive (`C:/…`) or UNC (`//server/…`) paths with forward slashes.
// POSIX paths are left alone: their names may legally contain backslashes.
export function posixPath(path: string): string {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path) ? path.replace(/\\/g, '/') : path
}

function batchEscape(value: string): string {
  return value.replace(/%/g, '%%')
}
