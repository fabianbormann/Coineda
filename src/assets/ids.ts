/**
 * NIGHT, the Midnight token, identified by its Cardano policy id plus asset
 * name in hex - never by its ticker.
 *
 * The ticker is the trap: CoinGecko lists TWO coins with the symbol NIGHT,
 * and the other one ('midnight') trades at about EUR 0.0000089 against this
 * one's EUR 0.040. Resolving a holding by symbol would have priced the
 * owner's 2136 NIGHT at about two cents instead of EUR 86 - a 4,500-fold
 * error with nothing downstream able to see it.
 *
 * These three ids live here, not in src/prices/scale.ts, only so that the
 * asset catalogue and the price modules can both import them without an
 * import cycle; scale.ts re-exports them under the same names.
 */
export const NIGHT_ASSET_ID =
  'cardano:0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa4e49474854';

export const USDT_ASSET_ID = 'eth:0xdac17f958d2ee523a2206206994597c13d831ec7';
export const USDC_ASSET_ID = 'eth:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
