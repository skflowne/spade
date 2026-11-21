import { createBuiltinEntityRegistry } from '@shared/builtinEntities'
import type { CanvasNode } from '@shared/domain'
import type { EntityDefinition } from '@shared/entities'
import type { EntityRendererDefinition } from './types'

// The shared, process-neutral definitions: display names, sizes, and config validation.
export const entities = createBuiltinEntityRegistry()

// Erases the config type so renderers of different entities share one list. The wrapper only ever passes
// a renderer the config its own shared definition parsed, so the erased type is never violated.
export function defineEntityRenderer<Config>(definition: EntityRendererDefinition<Config>): EntityRendererDefinition {
  return definition as unknown as EntityRendererDefinition
}

export class EntityRendererRegistry {
  private readonly renderers = new Map<string, EntityRendererDefinition>()

  constructor(renderers: readonly EntityRendererDefinition[]) {
    for (const renderer of renderers) {
      if (!entities.has(renderer.type)) throw new Error(`No shared entity definition for renderer ${renderer.type}`)
      if (this.renderers.has(renderer.type)) throw new Error(`Entity renderer already registered: ${renderer.type}`)
      this.renderers.set(renderer.type, renderer)
    }
  }

  get(type: string): EntityRendererDefinition | null {
    return this.renderers.get(type) ?? null
  }

  // Entity types a user can create, in registration order.
  creatable(): Array<{ definition: EntityDefinition; renderer: EntityRendererDefinition }> {
    return [...this.renderers.values()]
      .filter((renderer) => renderer.CreateForm !== undefined)
      .map((renderer) => ({ definition: entities.resolve(renderer.type), renderer }))
  }
}

export type ResolvedEntity =
  | { kind: 'ready'; definition: EntityDefinition; renderer: EntityRendererDefinition; config: unknown }
  // The type is not registered in this build, or its config does not parse: a generic body shows the record.
  | { kind: 'unknown'; definition: EntityDefinition | null; renderer: EntityRendererDefinition | null; problem: string }

export function resolveEntity(registry: EntityRendererRegistry, node: CanvasNode): ResolvedEntity {
  const definition = entities.has(node.entityType) ? entities.resolve(node.entityType) : null
  const renderer = registry.get(node.entityType)
  if (!definition || !renderer) {
    return { kind: 'unknown', definition, renderer, problem: `This build of SPADE cannot show “${node.entityType}” nodes.` }
  }
  try {
    return { kind: 'ready', definition, renderer, config: definition.parseConfig(node.config) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { kind: 'unknown', definition, renderer, problem: `This node's settings are not valid: ${reason}.` }
  }
}
