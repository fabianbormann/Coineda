import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { openLedger } from '@/ledger/db';
import { putCachedPrice, totalValue } from '@/prices/priceStore';
import { valueOf, ASSET_DECIMALS } from '@/prices/scale';
import { COINGECKO_IDS } from '@/prices/coingecko';
import { resolveValues } from '@/tax/resolveValues';
import { buildJourneySeries } from '@/journey/series';
import type { LedgerEvent } from '@/ledger/types';
import type { TaxEvent } from '@/tax/types';

/**
 * The unit bug, pinned at every boundary that turns an amount plus a price
 * into a fiat figure.
 *
 * CoinGecko's `cardano` price is the price of ONE ADA, and a ledger holding
 * is in lovelace (1 ADA = 10^6 lovelace), so a raw `amount * price` is
 * 1,000,000x too large. 10,000 ADA at EUR 0.30 is EUR 3,000, never
 * EUR 3,000,000,000 - and because there are three independent call sites,
 * each one is asserted separately so a later edit cannot fix two and leave
 * the third drifting.
 *
 * Deliberately no `indexedDB.deleteDatabase()`: that is a no-op while
 * `openLedger()` holds its memoised connection, so the stores are cleared
 * individually, the pattern tests/checkpointExport.test.ts established.
 */

/** 10,000 ADA, in the base unit the ledger actually stores. */
const TEN_THOUSAND_ADA_IN_LOVELACE = '10000000000';
const ADA_PRICE_EUR = '0.30';
/** 10,000 x 0.30. */
const EXPECTED_VALUE = '3000';

const ADA = 'cardano:lovelace';
const DAY = Date.UTC(2026, 0, 15);
const ISO_DAY = '2026-01-15';

beforeEach(async () => {
  const db = await openLedger();
  for (const store of ['events', 'prices', 'settings'] as const) {
    await db.clear(store);
  }
  // Every path below resolves its price from the cache, so nothing here
  // should ever reach the network. A fetch that throws proves it.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('no test in this file should reach the network');
    }),
  );
});

describe('the per-asset scale', () => {
  it('knows lovelace has 6 decimals', () => {
    expect(ASSET_DECIMALS[ADA]).toBe(6);
  });

  it('divides a base-unit amount by its asset scale', () => {
    expect(valueOf(TEN_THOUSAND_ADA_IN_LOVELACE, ADA_PRICE_EUR, ADA)).toBe(
      EXPECTED_VALUE,
    );
  });

  it('treats an unmapped asset as whole units rather than guessing a scale', () => {
    expect(valueOf('2', '1.5', 'unknown:thing')).toBe('3');
  });

  it('stays exact on an amount far beyond Number.MAX_SAFE_INTEGER', () => {
    // 10^19 lovelace is 10^13 ADA. A float would already have lost digits.
    expect(valueOf('10000000000000000001', '1', ADA)).toBe(
      '10000000000000.000001',
    );
  });

  it('maps at least one asset, so the gate below is not vacuous', () => {
    // Without this, an empty COINGECKO_IDS would make the it.each-style
    // loop below pass by iterating nothing.
    expect(Object.keys(COINGECKO_IDS).length).toBeGreaterThan(0);
  });

  it('knows the decimals of every asset it can price', () => {
    // decimalsOf returns 0 for an unknown asset, so a priced asset missing
    // here is priced in its BASE units as though they were whole units -
    // satoshis as bitcoin, 100,000,000x too large. This is the C1 defect
    // the tax milestone shipped for lovelace; the gate is what stops the
    // next asset repeating it silently.
    for (const assetId of Object.keys(COINGECKO_IDS)) {
      expect(
        ASSET_DECIMALS,
        `${assetId} can be priced but has no decimals`,
      ).toHaveProperty(assetId);
    }
  });

  it('scales a satoshi amount to whole bitcoin before pricing', () => {
    expect(valueOf('100000000', '50000', 'bitcoin:native')).toBe('50000');
  });

  it('scales a wei amount to whole ether before pricing', () => {
    // The gate above asserts an entry EXISTS, never that its number is
    // right - which is precisely the failure it cannot catch. 'eth:native'
    // was the proof: no module emits it and nothing authors it, so its
    // value was unreachable AND unpinned, and changing 18 to 7 broke none
    // of the 622 tests in this suite. This assertion is what makes the
    // number mean something.
    expect(valueOf('1000000000000000000', '3000', 'eth:native')).toBe('3000');
  });

  it('keeps full precision on a wei-scale division', () => {
    // 18 decimals is the deepest scale in the map, and the division is
    // pinned at DIVIDE_DP = 20 rather than inheriting a global Big.DP. One
    // wei at $3000/ETH is 3e-15, which must survive rather than round to
    // zero - a holding that rounds to nothing is a holding that vanishes
    // from a tax report.
    expect(valueOf('1', '3000', 'eth:native')).toBe('0.000000000000003');
  });
});

describe('every fiat boundary applies the scale', () => {
  it('values a tax event in the base currency, not in base units (resolveValues)', async () => {
    await putCachedPrice(
      { assetId: ADA, currency: 'eur', date: ISO_DAY },
      ADA_PRICE_EUR,
    );

    const disposal: TaxEvent = {
      sourceEventId: 'sell',
      kind: 'disposal',
      assetId: ADA,
      amount: TEN_THOUSAND_ADA_IN_LOVELACE,
      timestamp: DAY,
      venue: 'wallet-a',
    };

    const { valued, unpriced } = await resolveValues([disposal], 'eur');

    expect(unpriced).toEqual([]);
    expect(valued[0].value).toBe(EXPECTED_VALUE);
  });

  it('values a holding in the base currency, not in base units (totalValue)', () => {
    const { total, missing } = totalValue(
      [{ assetId: ADA, amount: TEN_THOUSAND_ADA_IN_LOVELACE }],
      new Map([[ADA, ADA_PRICE_EUR]]),
    );

    expect(missing).toEqual([]);
    expect(total).toBe(EXPECTED_VALUE);
  });

  it('values a journey point in the base currency, not in base units (buildJourneySeries)', async () => {
    await putCachedPrice(
      { assetId: ADA, currency: 'eur', date: ISO_DAY },
      ADA_PRICE_EUR,
    );

    const event: LedgerEvent = {
      id: 'buy',
      sourceId: 's1',
      externalId: 'buy',
      timestamp: DAY,
      kind: 'trade',
      origin: 'authored',
      legs: [
        {
          assetId: ADA,
          amount: TEN_THOUSAND_ADA_IN_LOVELACE,
          direction: 'in',
          venue: 'wallet-a',
          role: 'principal',
        },
      ],
    };

    // The journey itself draws AMOUNTS now and never prices a point, so the
    // scale boundary it still owns is the closing figure. That comes from
    // today's spot price, hence the clock: it makes the cache entry above
    // today's, which is the day resolveSpotPrices looks for.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(`${ISO_DAY}T12:00:00Z`));
    try {
      const series = await buildJourneySeries([event], 'eur', { now: DAY });

      expect(series.points).toHaveLength(1);
      expect(series.finalValue).toBe(EXPECTED_VALUE);
    } finally {
      vi.useRealTimers();
    }
  });
});
