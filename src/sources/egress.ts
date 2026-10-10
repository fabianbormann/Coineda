import { allowedHosts, type Endpoints } from '@/config/endpoints';
import { egressOf, type EgressConfig } from '@/config/egress';
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
 * from the device's endpoints (`manifest.endpoint`), so an override
 * there reaches the module instead of the module's own build-time
 * fallback. The stored config is never rewritten - an empty field keeps
 * following the endpoints if they change later.
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
 *
 * Compared on `URL.host` - host name AND port - exactly as `allowedHosts`
 * collects them: an operator who configured `indexer.example:8443` has not
 * thereby allowed whatever else listens on that machine's other ports.
 * Mode and endpoints are the device's (or `egress`, in tests), never a
 * client's settings.
 */
export const assertEgressAllowed = (
  module: SourceModule,
  config: Record<string, string>,
  egress?: EgressConfig,
): void => {
  const { mode, endpoints } = egressOf(egress);
  if (mode !== 'restricted') {
    return;
  }
  if (!module.manifest.selfHostable) {
    throw new EgressRefusedError();
  }
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
 * `fetchEvents`: refuses in restricted egress (EgressRefusedError), and
 * returns the config with a left-empty `baseUrl` filled from the device's
 * endpoints. Synchronous and settings-free, so no failed read can fall
 * back to a looser mode.
 */
export const prepareRun = (
  module: SourceModule,
  config: Record<string, string>,
  egress?: EgressConfig,
): Record<string, string> => {
  assertEgressAllowed(module, config, egress);
  return effectiveConfig(module, config, egressOf(egress).endpoints);
};
