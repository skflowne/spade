import {
  DEFAULT_APP_SETTINGS,
  DOMAIN_RECORD_VERSION,
  type AppSettings,
  type DomainRecordVersion,
  type Project
} from '../../shared/domain'
import { RecordValidationError, parseAppSettings, parseProject } from '../../shared/recordValidation'
import { isSafeId } from './safeId'

export type AppIndex = {
  version: DomainRecordVersion
  projects: Project[]
  settings: AppSettings
  selectedProjectId: string | null
}

const APP_INDEX_FIELDS = ['version', 'projects', 'settings', 'selectedProjectId']

export function createDefaultAppIndex(): AppIndex {
  return {
    version: DOMAIN_RECORD_VERSION,
    projects: [],
    settings: mergeSettingsOverDefaults({}),
    selectedProjectId: null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Keys a stored file lacks (for example settings added after it was written) take their defaults.
export function mergeSettingsOverDefaults(stored: unknown): AppSettings {
  if (!isPlainObject(stored)) throw new RecordValidationError('index.settings', 'must be an object')
  const expansion = stored.conversationExpansion
  return {
    ...DEFAULT_APP_SETTINGS,
    ...stored,
    conversationExpansion: isPlainObject(expansion)
      ? { ...DEFAULT_APP_SETTINGS.conversationExpansion, ...expansion }
      : (expansion ?? { ...DEFAULT_APP_SETTINGS.conversationExpansion })
  } as AppSettings
}

export function parseAppIndex(value: unknown): AppIndex {
  if (!isPlainObject(value)) throw new RecordValidationError('index', 'must be an object')
  for (const key of APP_INDEX_FIELDS) {
    if (value[key] === undefined) throw new RecordValidationError(`index.${key}`, 'is required')
  }
  for (const key of Object.keys(value)) {
    if (!APP_INDEX_FIELDS.includes(key)) throw new RecordValidationError(`index.${key}`, 'is not a known field')
  }
  if (value.version !== DOMAIN_RECORD_VERSION) {
    throw new RecordValidationError('index.version', `must be ${DOMAIN_RECORD_VERSION}`)
  }
  if (!Array.isArray(value.projects)) throw new RecordValidationError('index.projects', 'must be an array')
  const ids = new Set<string>()
  value.projects.forEach((candidate, index) => {
    const path = `index.projects[${index}]`
    const project = parseProject(candidate, path)
    // Project ids name canvas files.
    if (!isSafeId(project.id)) throw new RecordValidationError(`${path}.id`, 'is not a safe file name')
    if (ids.has(project.id)) throw new RecordValidationError(`${path}.id`, `duplicates ${project.id}`)
    ids.add(project.id)
  })
  parseAppSettings(value.settings, 'index.settings')
  if (value.selectedProjectId !== null && !ids.has(value.selectedProjectId as string)) {
    throw new RecordValidationError('index.selectedProjectId', 'must be null or the id of a listed project')
  }
  return value as AppIndex
}
