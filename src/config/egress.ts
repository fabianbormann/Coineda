import {
  egressMode,
  isConfigured,
  resolveEndpoints,
  type EgressMode,
  type Endpoints,
} from './endpoints';

/**
 * An explicit egress configuration, for tests and callers that must not
 * read the device's stored one. Absent: the device's own values
 * (src/config/deviceConfig.ts) under the build's precedence. Present: its
 * fields stand in for the device's (a missing `egress` is 'public', missing
 * `endpoints` are none) - a build's VITE_EGRESS / VITE_ENDPOINTS still win.
 */
export type EgressConfig = {
  egress?: EgressMode;
  endpoints?: Partial<Endpoints>;
};

/** The mode and resolved endpoints for `config`, or for the device. */
export const egressOf = (
  config?: EgressConfig,
): { mode: EgressMode; endpoints: Endpoints } =>
  config === undefined
    ? { mode: egressMode(), endpoints: resolveEndpoints() }
    : {
        mode: egressMode(config.egress ?? 'public'),
        endpoints: resolveEndpoints(config.endpoints ?? {}),
      };

/**
 * The endpoints the fetchers are actually allowed to use.
 *
 * In public mode this is `resolveEndpoints()`, unchanged. In restricted
 * mode every service still on its public default is blanked to `''`, which
 * every fetcher reads as "this service is not available": no request, and
 * the value reported missing through the path a provider outage already
 * takes. Nothing falls back to another host.
 *
 * `resolveEndpoints` itself never yields `''` (an empty override keeps the
 * default), so the blank is a signal only this function produces, and the
 * fetchers never need to know which mode they run in.
 *
 * Synchronous and device-level: nothing here reads a client's settings, so
 * neither a review client nor a failed settings read can change the answer.
 */
export const activeEndpoints = (config?: EgressConfig): Endpoints => {
  const { mode, endpoints } = egressOf(config);
  if (mode !== 'restricted') {
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
 * Key -> host name (`new URL(x).host`, port included) for every endpoint
 * that is in use: never a path, a query or a credential, so it is safe in a
 * document handed to a tax office. Blank (restricted, unconfigured) and
 * unparsable values are omitted.
 */
export const endpointHosts = (endpoints: Endpoints): Record<string, string> => {
  const hosts: Record<string, string> = {};
  for (const [key, value] of Object.entries(endpoints)) {
    if (!value) {
      continue;
    }
    try {
      hosts[key] = new URL(value).host;
    } catch {
      // Not a URL: nothing to name.
    }
  }
  return hosts;
};
