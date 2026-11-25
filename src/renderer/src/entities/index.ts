import { agentRenderer } from './agent'
import { imageRenderer } from './image'
import { noteRenderer } from './note'
import { EntityRendererRegistry } from './registry'
import { webPageRenderer } from './webpage'

export { defineEntityRenderer, entities, resolveEntity, type ResolvedEntity } from './registry'
export type * from './types'

// Compile-time registration (plan §5.5). Each entry needs a matching shared definition in builtinEntities.
export const entityRenderers = new EntityRendererRegistry([noteRenderer, agentRenderer, imageRenderer, webPageRenderer])
