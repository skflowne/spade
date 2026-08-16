import type { ResourceRef } from './domain'

export type EntityCreateInput<Config> = {
  nodeId: string
  config: Config
}

export type EntityCreateResult = {
  resourceRef: ResourceRef | null
  title?: string
  shortDescription?: string
}

export type EntityAdapter<Config> = {
  create(input: EntityCreateInput<Config>): EntityCreateResult
}

export type EntityDefinition<Config = unknown> = {
  type: string
  version: number
  displayName: string
  adapter: EntityAdapter<Config>
}

export class EntityRegistry {
  private readonly definitions = new Map<string, EntityDefinition>()

  register<Config>(definition: EntityDefinition<Config>): void {
    if (this.definitions.has(definition.type)) {
      throw new Error(`Entity type already registered: ${definition.type}`)
    }

    this.definitions.set(definition.type, definition as EntityDefinition)
  }

  resolve<Config = unknown>(type: string): EntityDefinition<Config> {
    const definition = this.definitions.get(type)

    if (!definition) {
      throw new Error(`Unknown entity type: ${type}`)
    }

    return definition as EntityDefinition<Config>
  }
}

export function createDeterministicMockAdapter<Config>(kind: string): EntityAdapter<Config> {
  return {
    create: ({ nodeId }) => ({
      resourceRef: {
        provider: 'mock',
        kind,
        id: nodeId
      }
    })
  }
}
