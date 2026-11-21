import { shellQuote } from './shims'

export type AgentInstructionsInput = {
  // The agent's own canvas node.
  nodeId: string
  projectName: string
  // `ControlServer.shimPath`.
  shimPath: string
  platform: NodeJS.Platform
}

// The few lines SPADE appends to an agent's initial prompt. The skill itself is fetched on demand with
// `<shim> skill`, so nothing is written into the project directory or provider-specific configuration.
export function formatAgentInstructions(input: AgentInstructionsInput): string {
  const command = input.platform === 'win32' ? `"${input.shimPath}"` : posixCommand(input.shimPath)
  const lines = [
    `You are running inside SPADE, a canvas that maps this work as nodes and trees. Your own node is ${input.nodeId} in project "${oneLine(input.projectName)}".`,
    `You can read and change that canvas with the SPADE CLI: ${command} <command>.`,
    `Before using the canvas, run \`${command} skill\` once and follow it.`,
    'Canvas changes are attributed to you and visible to the user; they never touch files.'
  ]
  if (input.platform === 'win32') lines.push(`In PowerShell, call it as \`& ${command} <command>\`.`)
  return lines.join('\n')
}

function posixCommand(path: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(path) ? path : shellQuote(path)
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
