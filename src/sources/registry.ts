import bitcoinEsplora from './bitcoin-esplora';
import bitpanda from './bitpanda';
import cardanoBlockfrost from './cardano-blockfrost';
import cardanoYaci from './cardano-yaci';
import type { SourceModule } from './types';

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
  bitpanda,
];

export const findModule = (id: string): SourceModule | undefined =>
  registry.find((module) => module.manifest.id === id);
