import { posixPath, powershellQuote, shellQuote, type ShimPaths } from './shims'

export type AgentInstructionsInput = {
  // The agent's own canvas node.
  nodeId: string
  projectName: string
  // `ControlServer.paths`.
  shims: ShimPaths
  platform: NodeJS.Platform
}

// The few lines SPADE appends to the initial prompt of an agent the user creates; agents started by other
// agents get none. The skill itself is fetched on demand with `<shim> skill`, so nothing is written into the
// project directory or provider-specific configuration.
export function formatAgentInstructions(input: AgentInstructionsInput): string {
  const bash = posixCommand(posixPath(input.shims.posixShim))
  const lines = [
    `You are running inside SPADE, a canvas that maps this work as nodes and trees. Your own node is ${input.nodeId} in project "${oneLine(input.projectName)}".`
  ]
  if (input.platform === 'win32') {
    // Agent harnesses on Windows mostly run Git Bash; cmd.exe re-parses quotes, &, |, >, and %VAR%.
    lines.push(
      'You can read and change that canvas with the SPADE CLI; use the launcher for your shell:',
      `- bash-like shells (Git Bash): ${bash} <command>`,
      `- PowerShell: & ${powershellQuote(input.shims.powershellShim)} <command>`,
      `- cmd.exe only: "${input.shims.windowsShim}" <command> (cmd.exe re-reads quotes, &, |, > and %: pass any free text through stdin with "-")`
    )
  } else {
    lines.push(`You can read and change that canvas with the SPADE CLI: ${bash} <command>.`)
  }
  lines.push(
    `Before using the canvas, run \`${bash} skill\`${input.platform === 'win32' ? " (or your shell's launcher)" : ''} once and follow it.`,
    'Change the canvas only when the user asks; changes are attributed to you and visible to the user, and never touch files.',
    "Agents you start, with `spawn agent` or Paseo's own tools, are owned by you and listed under you; message them with Paseo's tools."
  )
  return lines.join('\n')
}

function posixCommand(path: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(path) ? path : shellQuote(path)
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
