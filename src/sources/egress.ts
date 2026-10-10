import {
  allowedHosts,
  egressMode,
  resolveEndpoints,
  type Endpoints,
} from '@/config/endpoints';
import { getSettings, type Settings } from '@/settings/settingsStore';
import type { SourceModule } from './types';

/**
 * The text stored as a refused source's `lastError`. It is a translation
 * key (both locale files carry it): SourceRow renders `lastError` through
 * t(), and this one, unlike a provider's own diagnostic, is ours.
 */
export const EGRESS_REFUSED =
  'This source points at a host outside the configured endpoints.';

/** Thrown before any request is made, in restricted egress, for a source
 *  that would reach a host the operator did not configure. */
export class EgressRefusedError extends Error {
  constructor() {
    super(EGRESS_REFUSED);
    this.name = 'EgressRefusedError';
  }
}

const hasBaseUrlField = (module: SourceModule): boolean =>
  module.manifest.fields.some((field) => field.name === 'baseUrl');

/**
 * The config a module is actually run with: a left-empty `baseUrl` filled
 * from the client's endpoints (`manifest.endpoint`), so a per-client
 * override in `Settings.endpoints` reaches the module instead of the
 * module's own build-time fallback. The stored config is never rewritten -
 * an empty field keeps following the settings if they change later.
 */
export const effectiveConfig = (
  module: SourceModule,
  config: Record<string, string>,
  endpoints: Endpoints,
): Record<string, string> => {
  const key = module.manifest.endpoint;
  if (!key || !hasBaseUrlField(module) || (config.baseUrl ?? '').trim()) {
    return config;
  }
  return { ...config, baseUrl: endpoints[key] };
};

/** The base URL the module will contact, or '' when it cannot tell. */
const effectiveBase = (
  module: SourceModule,
  config: Record<string, string>,
  endpoints: Endpoints,
): string => {
  const configured = (config.baseUrl ?? '').trim();
  if (configured && hasBaseUrlField(module)) {
    return configured;
  }
  const key = module.manifest.endpoint;
  return key ? endpoints[key] : '';
};

/**
 * Restricted egress only: refuses, with EgressRefusedError, a module that
 * cannot be self-hosted or whose effective host is not one of the
 * configured endpoints' hosts. Public mode never refuses.
 */
export const assertEgressAllowed = (
  module: SourceModule,
  config: Record<string, string>,
  settings?: Pick<Settings, 'endpoints' | 'egress'> | null,
): void => {
  const mode = egressMode(settings);
  if (mode !== 'restricted') {
    return;
  }
  if (!module.manifest.selfHostable) {
    throw new EgressRefusedError();
  }
  const endpoints = resolveEndpoints(settings);
  let host: string;
  try {
    host = new URL(effectiveBase(module, config, endpoints)).host;
  } catch {
    throw new EgressRefusedError();
  }
  if (!allowedHosts(endpoints, mode).has(host)) {
    throw new EgressRefusedError();
  }
};

/**
 * Everything the host does before handing a config to `probe` or
 * `fetchEvents`: reads the open client's settings, refuses in restricted
 * egress (EgressRefusedError), and returns the config with a left-empty
 * `baseUrl` filled from the client's endpoints. An unreadable settings row
 * falls back to the build's defaults, which still honour a build-time
 * `VITE_EGRESS=restricted`.
 */
export const prepareRun = async (
  module: SourceModule,
  config: Record<string, string>,
): Promise<Record<string, string>> => {
  let settings: Settings | null = null;
  try {
    settings = await getSettings();
  } catch {
    // Build defaults.
  }
  assertEgressAllowed(module, config, settings);
  return effectiveConfig(module, config, resolveEndpoints(settings));
};
