import { join } from 'node:path'
import { createAgentService } from './agents'
import type { AgentService, FileService, WorkspaceGateway } from './contracts'
import { createControlServer, formatAgentInstructions, type ControlServer } from './control'
import { createElectronFileServiceHost, createFileService, registerFileServiceSchemes } from './files'
import { createPaseoAdapter } from './paseo'
import type { AssetStore } from './persistence'
import type { EntityRegistry } from '../shared/entities'

export type ServiceDependencies = {
  gateway: WorkspaceGateway
  assets: AssetStore
  entities: EntityRegistry
  // SPADE's application-data directory (under userData).
  dataDirectory: string
}

export type Services = {
  agents: AgentService
  files: FileService
  // The local endpoint the agent CLI talks to.
  control: ControlServer
}

// Runs before `app.whenReady()`, for work Electron only accepts that early (privileged protocol schemes).
export function prepareServices(): void {
  registerFileServiceSchemes()
}

// The one place the concrete services are chosen. Builds them and registers their entity adapters.
export function createServices(dependencies: ServiceDependencies): Services {
  const { gateway, entities, dataDirectory } = dependencies

  const agents: AgentService = createAgentService({
    gateway,
    paseo: createPaseoAdapter({ setting: gateway.getSettings().paseoUrl }),
    entities,
    agentInstructions: ({ nodeId, project }) =>
      formatAgentInstructions({
        nodeId,
        projectName: project.name,
        shimPath: control.shimPath,
        platform: process.platform
      })
  })
  const files = createFileService({ host: createElectronFileServiceHost(), assetStore: dependencies.assets })
  const control = createControlServer({
    gateway,
    agentService: agents,
    entities,
    dataDirectory,
    // The CLI is emitted next to the main bundle.
    cliScriptPath: join(import.meta.dirname, 'cli.js'),
    executablePath: process.execPath
  })

  for (const adapter of [agents.entityAdapter, files.imageEntityAdapter, files.webPageEntityAdapter]) {
    gateway.registerEntityAdapter(adapter)
  }
  return { agents, files, control }
}
