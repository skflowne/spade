import { PaseoAdapter } from './PaseoAdapter'
import { resolvePaseoUrl } from './url'

export {
  PASEO_CLIENT_APP_VERSION,
  PaseoAdapter,
  PaseoUnavailableError,
  daemonClientOptions,
  type PaseoAdapterEvent,
  type PaseoAdapterOptions,
  type PaseoDaemonDriver,
  type PaseoTimelinePage,
  type ProviderSubagentListing,
  type SpawnAgentInput
} from './PaseoAdapter'
export { normalizeTimeline, type PaseoTimelineRow } from './normalizeTimeline'
export { ARCHIVED_AGENT_STATUS, PARENT_AGENT_ID_LABEL, agentActivity, type PaseoAgentSnapshot } from './snapshots'
export { DEFAULT_PASEO_URL, PASEO_URL_ENV, resolvePaseoUrl, type PaseoUrlSource } from './url'

export const PASEO_DISABLE_ENV = 'SPADE_DISABLE_PASEO'

// The production composition: the resolved daemon URL, or a disabled adapter when the environment
// opts out (tests, offline use).
export function createPaseoAdapter(input: {
  setting?: string | null
  env?: Readonly<Record<string, string | undefined>>
} = {}): PaseoAdapter {
  const env = input.env ?? process.env
  const { url } = resolvePaseoUrl({ setting: input.setting, env })
  return new PaseoAdapter({ url, disabled: env[PASEO_DISABLE_ENV] === '1' })
}
