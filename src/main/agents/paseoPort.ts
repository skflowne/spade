import { PaseoUnavailableError, type PaseoAdapter } from '../paseo'
import { AgentServiceError } from './errors'

// The part of the Paseo adapter the agent service uses. Nothing here archives or stops an agent:
// removing or archiving a node in SPADE never touches the Paseo agent behind it.
export type PaseoPort = Pick<
  PaseoAdapter,
  | 'start'
  | 'stop'
  | 'connection'
  | 'subscribe'
  | 'watchTimelines'
  | 'listProviders'
  | 'spawnAgent'
  | 'getAgent'
  | 'listChildAgents'
  | 'sendPrompt'
  | 'interrupt'
  | 'respondToPermission'
  | 'agentTimeline'
  | 'listProviderSubagents'
  | 'providerSubagentTimeline'
>

// Runs a Paseo request on behalf of a caller, turning adapter failures into stable service errors.
export async function callPaseo<Value>(what: string, request: () => Promise<Value>): Promise<Value> {
  try {
    return await request()
  } catch (error) {
    if (error instanceof AgentServiceError) throw error
    if (error instanceof PaseoUnavailableError) throw new AgentServiceError('paseo-unavailable', error.message)
    throw new AgentServiceError('paseo-failed', `Paseo could not ${what}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
