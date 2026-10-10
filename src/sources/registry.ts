import bitcoinEsplora from './bitcoin-esplora';
import bitpanda from './bitpanda';
import cardanoBlockfrost from './cardano-blockfrost';
import cardanoYaci from './cardano-yaci';
import ethereumBlockscout from './ethereum-blockscout';
import type { SourceModule } from './types';
import {
  isConfigured,
  resolveEndpoints,
  type EgressMode,
  type Endpoints,
} from '@/config/endpoints';

/**
 * Modules ship in the bundle and are added by reviewed pull request.
 *
 * Nothing is ever loaded at runtime: module code runs beside the user's
 * exchange API keys, so a fetched-and-evaluated module would be arbitrary code
 * execution next to their secrets. LLM authorship works fine against this -
 * the interface and the conformance fixtures are what make a module
 * generatable, not the loading mechanism.
 */
export const registry: SourceModule[] = [
  cardanoYaci,
  cardanoBlockfrost,
  bitcoinEsplora,
  ethereumBlockscout,
  bitpanda,
];

export const findModule = (id: string): SourceModule | undefined =>
  registry.find((module) => module.manifest.id === id);

/**
 * The modules a person may add in this egress mode.
 *
 * Public: all of them. Restricted: only a module that can be self-hosted
 * and, when it takes its base URL from the endpoints (`manifest.endpoint`),
 * only once the operator has configured that service - a module still
 * pointing at its public default could reach nothing it is allowed to.
 * Reads `registry` at call time, so tests that swap its contents see them.
 */
export const visibleModules = (
  mode: EgressMode,
  endpoints: Endpoints = resolveEndpoints(),
): SourceModule[] =>
  mode === 'public'
    ? [...registry]
    : registry.filter(
        ({ manifest }) =>
          manifest.selfHostable &&
          (manifest.endpoint === undefined ||
            isConfigured(endpoints, manifest.endpoint)),
      );
