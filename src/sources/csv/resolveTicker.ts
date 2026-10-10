import { ASSET_CATALOGUE, resolveSymbol } from '@/assets/catalogue';

/**
 * An exchange ticker to a Coineda asset id, through the asset catalogue.
 *
 * `aliases` maps the exchange's own spelling to a catalogue symbol (Kraken's
 * XXBT to BTC). `explicit` maps a ticker straight to a full asset id, for the
 * few the catalogue cannot answer by symbol because the symbol is ambiguous
 * (NIGHT). A fiat entry resolves to its `fiat:<iso>` id, which is the
 * catalogue's own id for it.
 */
export const resolveTicker = (
  ticker: string,
  aliases: Record<string, string> = {},
  explicit: Record<string, string> = {},
): string | null => {
  const code = ticker.trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(explicit, code)) {
    return explicit[code];
  }
  const symbol = Object.prototype.hasOwnProperty.call(aliases, code)
    ? aliases[code]
    : code;
  return resolveSymbol(symbol)?.id ?? null;
};

/** Every ticker the catalogue can answer (plus the explicit ones), as a
 *  plain map: a view for callers and tests that enumerate, derived from
 *  `resolveTicker` so it cannot drift from it. */
export const tickerMap = (
  explicit: Record<string, string> = {},
): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const entry of ASSET_CATALOGUE) {
    const id = resolveSymbol(entry.symbol)?.id;
    if (id !== undefined) map[entry.symbol.toUpperCase()] = id;
  }
  return { ...map, ...explicit };
};
