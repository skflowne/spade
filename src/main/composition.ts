import { createAgentService } from './agents'
import type { AgentService, FileService, WorkspaceGateway } from './contracts'
import { createPaseoAdapter } from './paseo'
import type { AssetStore } from './persistence'
import { createUnavailableFileService } from './unavailableServices'
import { createBuiltinEntityRegistry } from '../shared/builtinEntities'

export type ServiceDependencies = {
  gateway: WorkspaceGateway
  assets: AssetStore
  // SPADE's application-data directory (under userData).
  dataDirectory: string
}

export type Services = {
  agents: AgentService
  files: FileService
}

// Runs before `app.whenReady()`, for work Electron only accepts that early (privileged protocol schemes).
export function prepareServices(): void {}

// The one place the concrete services are chosen. Builds them and registers their entity adapters.
export function createServices(dependencies: ServiceDependencies): Services {
  const agents = createAgentService({
    gateway: dependencies.gateway,
    paseo: createPaseoAdapter({ setting: dependencies.gateway.getSettings().paseoUrl }),
    entities: createBuiltinEntityRegistry()
  })
  const files = createUnavailableFileService()

  for (const adapter of [agents.entityAdapter, files.imageEntityAdapter, files.webPageEntityAdapter]) {
    dependencies.gateway.registerEntityAdapter(adapter)
  }
  return { agents, files }
}
