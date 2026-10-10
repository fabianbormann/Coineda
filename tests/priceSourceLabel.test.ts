import { describe, it, expect, beforeAll } from 'vitest';
import i18n from '@/i18n';
import { describePriceSource } from '@/components/money/priceSource';

describe('describePriceSource', () => {
  beforeAll(async () => {
    await i18n.init();
  });

  it('translates the host words and keeps provider names verbatim', () => {
    const de = i18n.getFixedT('de');
    expect(describePriceSource('consideration · base currency', de)).toBe(
      'Gegenleistung · Basiswährung',
    );
    expect(describePriceSource('consideration · ECB', de)).toBe(
      'Gegenleistung · ECB',
    );
    expect(describePriceSource('cache (source not recorded)', de)).toBe(
      'Cache (Quelle nicht erfasst)',
    );
    expect(describePriceSource('none (zero amount)', de)).toBe(
      'keine (Nullbetrag)',
    );
    expect(describePriceSource('DefiLlama', de)).toBe('DefiLlama');
    expect(describePriceSource('CoinGecko', de)).toBe('CoinGecko');
  });

  it('reads the same as the token in English', () => {
    const en = i18n.getFixedT('en');
    expect(describePriceSource('consideration · CoinGecko', en)).toBe(
      'consideration · CoinGecko',
    );
  });
});
