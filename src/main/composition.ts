import type { AgentService, FileService, WorkspaceGateway } from './contracts'
import type { AssetStore } from './persistence'
import { createUnavailableAgentService, createUnavailableFileService } from './unavailableServices'

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
  const agents = createUnavailableAgentService()
  const files = createUnavailableFileService()

  for (const adapter of [agents.entityAdapter, files.imageEntityAdapter, files.webPageEntityAdapter]) {
    dependencies.gateway.registerEntityAdapter(adapter)
  }
  return { agents, files }
}
