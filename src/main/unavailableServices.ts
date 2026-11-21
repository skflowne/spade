import type { AgentService, FileService, MainEntityAdapter } from './contracts'
import { AGENT_ENTITY, IMAGE_ENTITY, WEB_PAGE_ENTITY } from '../shared/builtinEntities'

// Stand-ins for services this build does not include: queries answer empty or disabled, and every
// action rejects with a ServiceUnavailableError.

export class ServiceUnavailableError extends Error {
  readonly code = 'service-unavailable'

  constructor(what: string) {
    super(`${what} is not available in this build of SPADE.`)
    this.name = 'ServiceUnavailableError'
  }
}

function unavailableAdapter(type: string, what: string): MainEntityAdapter {
  return { type, create: async () => Promise.reject(new ServiceUnavailableError(what)) }
}

const noSubscription = (): (() => void) => () => {}

export function createUnavailableAgentService(): AgentService {
  const reject = async (): Promise<never> => Promise.reject(new ServiceUnavailableError('Agents'))
  return {
    entityAdapter: unavailableAdapter(AGENT_ENTITY, 'Agents'),
    start: async () => {},
    stop: async () => {},
    connection: () => ({ state: 'disabled', url: '', error: 'Agents are not available in this build of SPADE.' }),
    listProviders: async () => [],
    runtimes: () => [],
    timeline: async (nodeId) => ({ nodeId, epoch: null, items: [], olderCursor: null }),
    prompt: reject,
    interrupt: reject,
    respondToPermission: reject,
    openProviderSubagent: reject,
    subscribe: noSubscription
  }
}

export function createUnavailableFileService(): FileService {
  const reject = async (): Promise<never> => Promise.reject(new ServiceUnavailableError('File access'))
  return {
    imageEntityAdapter: unavailableAdapter(IMAGE_ENTITY, 'Image nodes'),
    webPageEntityAdapter: unavailableAdapter(WEB_PAGE_ENTITY, 'Web page nodes'),
    start: async () => {},
    stop: async () => {},
    inspectPath: reject,
    reveal: reject,
    openExternal: reject,
    copyText: () => {
      throw new ServiceUnavailableError('Copying')
    },
    pickImage: reject,
    describeImage: reject,
    importImage: reject,
    subscribe: noSubscription
  }
}
