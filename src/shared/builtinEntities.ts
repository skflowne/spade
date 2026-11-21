import { EntityRegistry, type EntityDefinition } from './entities'

export type NoteConfig = { body: string }

export type AgentConfig = {
  provider: string
  // Null when the node mirrors an agent SPADE did not spawn (a delegated sub-agent).
  model: string | null
  mode: string | null
  // The initial prompt as the caller wrote it, without any SPADE-added context.
  prompt: string | null
}

export type ImageSource = { kind: 'path'; path: string } | { kind: 'asset'; assetId: string }
export type ImageConfig = { source: ImageSource; caption?: string }

export type WebPageConfig = { url: string }

export const NOTE_ENTITY = 'note'
export const AGENT_ENTITY = 'agent'
export const IMAGE_ENTITY = 'image'
export const WEB_PAGE_ENTITY = 'webpage'

// Resource kinds under provider "paseo" for agent nodes.
export const PASEO_AGENT_KIND = 'agent'
export const PASEO_PROVIDER_SUBAGENT_KIND = 'provider-subagent'

function record(value: unknown, entity: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${entity} config must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  return text(value, field)
}

export const noteEntity: EntityDefinition<NoteConfig> = {
  type: NOTE_ENTITY,
  version: 1,
  displayName: 'Note',
  defaultSize: { width: 320, height: 200 },
  collapsedSize: { width: 320, height: 96 },
  parseConfig(value) {
    const config = record(value, 'Note')
    if (typeof config.body !== 'string') throw new Error('body must be a string')
    return { body: config.body }
  }
}

export const agentEntity: EntityDefinition<AgentConfig> = {
  type: AGENT_ENTITY,
  version: 1,
  displayName: 'Agent',
  defaultSize: { width: 640, height: 720 },
  collapsedSize: { width: 320, height: 96 },
  parseConfig(value) {
    const config = record(value, 'Agent')
    return {
      provider: text(config.provider, 'provider'),
      model: optionalText(config.model, 'model'),
      mode: optionalText(config.mode, 'mode'),
      prompt: optionalText(config.prompt, 'prompt')
    }
  }
}

export const imageEntity: EntityDefinition<ImageConfig> = {
  type: IMAGE_ENTITY,
  version: 1,
  displayName: 'Image',
  // Used until the image's own dimensions are known; the main-process adapter returns a fitted size.
  defaultSize: { width: 560, height: 420 },
  collapsedSize: { width: 320, height: 96 },
  parseConfig(value) {
    const config = record(value, 'Image')
    const source = record(config.source, 'Image source')
    const caption = optionalText(config.caption, 'caption')
    const parsedSource: ImageSource =
      source.kind === 'asset'
        ? { kind: 'asset', assetId: text(source.assetId, 'assetId') }
        : source.kind === 'path'
          ? { kind: 'path', path: text(source.path, 'path') }
          : (() => {
              throw new Error('source.kind must be "path" or "asset"')
            })()
    return caption === null ? { source: parsedSource } : { source: parsedSource, caption }
  }
}

export const webPageEntity: EntityDefinition<WebPageConfig> = {
  type: WEB_PAGE_ENTITY,
  version: 1,
  displayName: 'Web page',
  defaultSize: { width: 960, height: 640 },
  collapsedSize: { width: 320, height: 96 },
  parseConfig(value) {
    const config = record(value, 'Web page')
    const url = text(config.url, 'url')
    if (!/^https?:\/\//i.test(url)) throw new Error('url must be an http or https URL')
    return { url }
  }
}

export function createBuiltinEntityRegistry(): EntityRegistry {
  const registry = new EntityRegistry()
  registry.register(noteEntity)
  registry.register(agentEntity)
  registry.register(imageEntity)
  registry.register(webPageEntity)
  return registry
}
