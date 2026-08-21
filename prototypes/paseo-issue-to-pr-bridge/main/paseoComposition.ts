import { SpadePaseoAdapter } from './SpadePaseoAdapter'

export const DEFAULT_PASEO_URL = 'ws://127.0.0.1:6767/ws'

export function createConfiguredPaseoAdapter(
  environment: NodeJS.ProcessEnv
): SpadePaseoAdapter | undefined {
  if (environment.SPADE_P3_DISABLE_PASEO === '1') return undefined
  return new SpadePaseoAdapter({
    url: environment.SPADE_P3_PASEO_URL ?? DEFAULT_PASEO_URL
  })
}
