import type { AgentService, FileService, WorkspaceGateway } from './contracts'
import { createElectronFileServiceHost, createFileService, registerFileServiceSchemes } from './files'
import type { AssetStore } from './persistence'
import { createUnavailableAgentService } from './unavailableServices'

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
export function prepareServices(): void {
  registerFileServiceSchemes()
}

// The one place the concrete services are chosen. Builds them and registers their entity adapters.
export function createServices(dependencies: ServiceDependencies): Services {
  const agents = createUnavailableAgentService()
  const files = createFileService({ host: createElectronFileServiceHost(), assetStore: dependencies.assets })

  for (const adapter of [agents.entityAdapter, files.imageEntityAdapter, files.webPageEntityAdapter]) {
    dependencies.gateway.registerEntityAdapter(adapter)
  }
  return { agents, files }
}
