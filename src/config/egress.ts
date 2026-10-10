import { getSettings, type Settings } from '@/settings/settingsStore';
import {
  egressMode,
  isConfigured,
  resolveEndpoints,
  type Endpoints,
} from './endpoints';

/**
 * The endpoints the fetchers are actually allowed to use.
 *
 * In public mode this is `resolveEndpoints(settings)`, unchanged. In
 * restricted mode every service still on its public default is blanked to
 * `''`, which every fetcher reads as "this service is not available": no
 * request, and the value reported missing through the path a provider
 * outage already takes. Nothing falls back to another host.
 *
 * `resolveEndpoints` itself never yields `''` (an empty override keeps the
 * default), so the blank is a signal only this function produces, and the
 * fetchers never need to know which mode they run in.
 */
export const activeEndpoints = (
  settings?: Pick<Settings, 'endpoints' | 'egress'> | null,
): Endpoints => {
  const endpoints = resolveEndpoints(settings);
  if (egressMode(settings) !== 'restricted') {
    return endpoints;
  }
  const active = { ...endpoints };
  for (const key of Object.keys(active) as (keyof Endpoints)[]) {
    if (!isConfigured(endpoints, key)) {
      active[key] = '';
    }
  }
  return active;
};

/**
 * `activeEndpoints` for the client whose ledger is open now, read from its
 * stored settings. For the callers that do not already hold the settings
 * (the spot-price and token-metadata caches). An unreadable settings row
 * degrades to the build's own defaults - which still honour a build-time
 * `VITE_EGRESS=restricted` - rather than throwing into a balance screen.
 */
export const currentEndpoints = async (): Promise<Endpoints> => {
  try {
    return activeEndpoints(await getSettings());
  } catch {
    return activeEndpoints(null);
  }
};
