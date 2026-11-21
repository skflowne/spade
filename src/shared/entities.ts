import type { Size } from './domain'

// Shared, process-neutral part of an entity: identity, legible sizes, and config validation.
// Resource creation lives in main-process entity adapters; body rendering lives in the renderer.
export type EntityDefinition<Config = unknown> = {
  type: string
  version: number
  displayName: string
  // Readable at 100% zoom (plan §8). Placement reserves this footprint even while collapsed.
  defaultSize: Size
  collapsedSize: Size
  // Returns the validated config or throws an Error describing the first problem.
  parseConfig(value: unknown): Config
  // What an agent is told about a node beyond its title (plan §9). Callers truncate the result.
  describeForAgent?(config: Config): AgentDescription
}

export type AgentDescription = {
  // Where the content lives, e.g. { kind: 'url', value: 'https://…' }.
  locator?: { kind: string; value: string }
  excerpt?: string
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

  has(type: string): boolean {
    return this.definitions.has(type)
  }

  list(): EntityDefinition[] {
    return [...this.definitions.values()]
  }
}
