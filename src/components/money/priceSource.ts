import type { TFunction } from 'i18next';

/**
 * A `TaxEvent.priceSource` token as a reader of the report's language sees it.
 *
 * The token stays a machine string in the data (and in the register file);
 * only the rendering is translated. It is a ` · `-joined chain -
 * `consideration · ECB` reads "valued at the consideration, which ECB
 * priced" - so each part is looked up on its own: the host's own words are
 * translated, a provider's name (DefiLlama, ECB, CoinGecko) is a proper
 * noun and passes through verbatim, as does anything not listed here.
 *
 * An explicit switch rather than `t(part)`, so every key is a literal the
 * locale files and a grep can both see.
 */
export const describePriceSource = (token: string, t: TFunction): string =>
  token
    .split(' · ')
    .map((part) => {
      switch (part) {
        case 'consideration':
          return t('consideration');
        case 'base currency':
          return t('base currency');
        case 'cache (source not recorded)':
          return t('cache (source not recorded)');
        case 'none (zero amount)':
          return t('none (zero amount)');
        default:
          return part;
      }
    })
    .join(' · ');
