import { describe, expect, it } from 'vitest';
import {
  aggregateLedger,
  type OwnCategory,
  type OwnFigures,
} from '@/carf/aggregate';
import { sha256Hex } from '@/carf/hash';
import { reconcile, reconciliationToCsv } from '@/carf/reconcile';
import type {
  CarfAssetReport,
  CarfBlock,
  CarfCategory,
  CarfMessage,
  CarfUser,
} from '@/carf/types';
import { NIGHT_ASSET_ID } from '@/assets/ids';
import { ledgerEvent } from './helpers/ledger';

const BTC = 'bitcoin:native';
const ETH = 'eth:native';

const block = (
  category: CarfCategory,
  overrides: Partial<CarfBlock> = {},
): CarfBlock => ({
  category,
  transactions: 3,
  amount: '15000.00',
  currency: 'EUR',
  units: '0.250000',
  ...overrides,
});

const own = (overrides: Partial<OwnCategory> = {}): OwnCategory => ({
  transactions: 3,
  units: '25000000',
  amount: '15000',
  fees: '0',
  byType: {},
  ...overrides,
});

const userOf = (assets: CarfAssetReport[]): CarfUser => ({
  name: 'Erika Mustermann',
  tins: [{ value: '123', issuedBy: 'DE' }],
  docRefId: 'D1',
  docTypeIndic: 'OECD1',
  assets,
});

const messageOf = (
  user: CarfUser,
  overrides: Partial<CarfMessage> = {},
): CarfMessage => ({
  messageRefId: 'M1',
  messageTypeIndic: 'CARF701',
  reportingPeriod: '2026-12-31',
  year: 2026,
  timestamp: '2027-03-15T10:20:30',
  transmittingCountry: 'DE',
  receivingCountry: 'DE',
  provider: { name: 'Bitpanda GmbH', docRefId: 'P1' },
  users: [user],
  ...overrides,
});

const run = (
  assets: CarfAssetReport[],
  figures: OwnFigures,
  extra: Partial<CarfMessage> = {},
  baseCurrency = 'eur',
) => {
  const user = userOf(assets);
  return reconcile({
    message: messageOf(user, extra),
    user,
    own: figures,
    baseCurrency,
    fileHash: 'abc123',
    sources: [{ id: 's1', label: 'Bitpanda' }],
  });
};

const one = (b: CarfBlock, o: OwnCategory | undefined, base = 'eur') =>
  run(
    [{ name: 'BTC', blocks: [b] }],
    o ? { [BTC]: { [b.category]: o } } : {},
    {},
    base,
  ).rows[0];

describe('reconcile verdicts', () => {
  it('matches an exact fiat-in row', () => {
    const row = one(block('fiat-in'), own());
    expect(row.verdict).toBe('match');
    expect(row.assetId).toBe(BTC);
    expect(row.symbol).toBe('BTC');
    expect(row.own?.units).toBe('0.25');
    expect(row.delta).toEqual({ transactions: 0, units: '0', amount: '0' });
  });

  it('accepts a 0.5 % amount gap', () => {
    expect(one(block('fiat-in'), own({ amount: '15075' })).verdict).toBe(
      'match',
    );
  });

  it('rejects a 1.5 % amount gap', () => {
    const row = one(block('fiat-in'), own({ amount: '15225' }));
    expect(row.verdict).toBe('differs');
    expect(row.delta.amount).toBe('225');
  });

  it('accepts a 0.80 gap on 20.00 through the absolute floor', () => {
    const row = one(
      block('fiat-in', { amount: '20.00' }),
      own({ amount: '20.8' }),
    );
    expect(row.verdict).toBe('match');
  });

  it('rounds own units to six decimals before comparing', () => {
    // 0.2500004 BTC is 25000040 satoshi-fractions: use ETH (18 decimals).
    const eth = (units: string) =>
      run(
        [{ name: 'ETH', blocks: [block('fiat-in', { units: '0.250000' })] }],
        { [ETH]: { 'fiat-in': own({ units }) } },
      ).rows[0];
    const low = eth('250000400000000000');
    expect(low.own?.units).toBe('0.25');
    expect(low.verdict).toBe('match');
    const high = eth('250000600000000000');
    expect(high.own?.units).toBe('0.250001');
    expect(high.verdict).toBe('differs');
  });

  it('differs on a count mismatch with the delta', () => {
    const row = one(
      block('fiat-in', { transactions: 2 }),
      own({ transactions: 3 }),
    );
    expect(row.verdict).toBe('differs');
    expect(row.delta.transactions).toBe(1);
  });

  it('is not-compared when the currency is not the base currency', () => {
    const row = one(block('fiat-in', { currency: 'USD' }), own());
    expect(row.verdict).toBe('not-compared');
    expect(row.delta.units).toBe('0');
    expect(row.delta.transactions).toBe(0);
    expect(row.delta.amount).toBeUndefined();
    expect(row.note).toBe('Reported in {{currency}}');
    expect(row.noteParams).toEqual({ currency: 'USD' });
  });

  it('differs in another currency when counts or units disagree', () => {
    const count = one(
      block('fiat-in', { currency: 'USD' }),
      own({ transactions: 1 }),
    );
    expect(count.verdict).toBe('differs');
    expect(count.note).toBe('Reported in {{currency}}');
    expect(count.noteParams).toEqual({ currency: 'USD' });
    expect(count.delta.amount).toBeUndefined();
    const units = one(
      block('fiat-in', { currency: 'USD' }),
      own({ units: '1' }),
    );
    expect(units.verdict).toBe('differs');
  });

  it('treats a missing reported currency as not comparable', () => {
    expect(one(block('fiat-in', { currency: '' }), own()).verdict).toBe(
      'not-compared',
    );
  });

  it('compares the currency case-insensitively', () => {
    expect(
      one(block('fiat-in', { currency: 'eur' }), own(), 'EUR').verdict,
    ).toBe('match');
  });

  it('is not-compared for rrpt', () => {
    expect(one(block('rrpt'), own()).verdict).toBe('not-compared');
  });

  it('flags own-only rows as not-reported', () => {
    const r = run([], { [BTC]: { 'fiat-in': own() } });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].verdict).toBe('not-reported');
    expect(r.rows[0].reported).toBeUndefined();
    expect(r.rows[0].delta).toEqual({});
  });

  it('flags reported-only rows as missing-own', () => {
    const row = one(block('fiat-in'), undefined);
    expect(row.verdict).toBe('missing-own');
    expect(row.own).toBeUndefined();
    expect(row.delta).toEqual({});
  });

  it('is unpriced when the own amount is unknown but counts and units agree', () => {
    expect(one(block('crypto-in'), own({ amount: undefined })).verdict).toBe(
      'unpriced',
    );
    expect(
      one(block('crypto-in'), own({ amount: undefined, transactions: 4 }))
        .verdict,
    ).toBe('differs');
  });

  it('marks every row not-reported under CARF703', () => {
    const r = run(
      [{ name: 'BTC', blocks: [block('fiat-in')] }],
      { [BTC]: { 'fiat-in': own(), 'fiat-out': own() } },
      { messageTypeIndic: 'CARF703' },
    );
    expect(r.rows.map((x) => x.verdict)).toEqual([
      'not-reported',
      'not-reported',
    ]);
  });

  it('marks every own row not-reported when the message names no user', () => {
    const message = messageOf(userOf([]), {
      messageTypeIndic: 'CARF703',
      users: [],
    });
    const r = reconcile({
      message,
      own: { [BTC]: { 'fiat-in': own(), 'transfer-out': own() } },
      baseCurrency: 'eur',
      fileHash: 'h',
      sources: [{ id: 's1', label: 'Bitpanda' }],
    });
    expect(r.user).toBeUndefined();
    expect(r.rows.map((x) => x.verdict)).toEqual([
      'not-reported',
      'not-reported',
    ]);
    expect(r.unrecognised).toEqual([]);
    expect(r.summary['not-reported']).toBe(2);
  });

  it('ignores a missing reported transaction count', () => {
    const row = one(
      block('wallet', { transactions: undefined }),
      own({ transactions: 7 }),
    );
    expect(row.verdict).toBe('match');
    expect(row.delta.transactions).toBeUndefined();
  });
});

describe('reconcile structure', () => {
  it('sums blocks of one category and keeps them per type', () => {
    const r = run(
      [
        {
          name: 'BTC',
          blocks: [
            block('transfer-in', {
              type: 'CARF502',
              transactions: 2,
              amount: '10.50',
              units: '0.1',
            }),
            block('transfer-in', {
              type: 'CARF501',
              transactions: 1,
              amount: '4.50',
              units: '0.05',
            }),
            block('transfer-in', {
              transactions: 1,
              amount: '1.00',
              units: '0.01',
            }),
          ],
        },
      ],
      {},
    );
    const rep = r.rows[0].reported!;
    expect(rep.transactions).toBe(4);
    expect(rep.units).toBe('0.16');
    expect(rep.amount).toBe('16');
    expect(rep.byType['CARF502']).toEqual({
      transactions: 2,
      units: '0.1',
      amount: '10.5',
    });
    expect(Object.keys(rep.byType).sort()).toEqual(['', 'CARF501', 'CARF502']);
  });

  it('merges names that resolve to one asset and notes it', () => {
    const r = run(
      [
        { name: 'BTC', blocks: [block('fiat-in', { transactions: 1 })] },
        { name: 'Bitcoin', blocks: [block('fiat-in', { transactions: 2 })] },
      ],
      {},
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].reported?.transactions).toBe(3);
    expect(r.rows[0].note).toBe('Reported under several names: {{names}}');
    expect(r.rows[0].noteParams).toEqual({ names: 'BTC, Bitcoin' });
  });

  it('carries unrecognised assets with their blocks', () => {
    const night: CarfAssetReport = { name: 'NIGHT', blocks: [block('wallet')] };
    const r = run([night, { name: 'BTC', blocks: [block('fiat-in')] }], {});
    expect(r.unrecognised).toEqual([night]);
    expect(r.rows.every((x) => x.assetId !== NIGHT_ASSET_ID)).toBe(true);
    expect(r.summary['not-recognised']).toBe(1);
  });

  it('lists a reported fiat currency apart, not as unrecognised', () => {
    const eur: CarfAssetReport = { name: 'EUR', blocks: [block('fiat-in')] };
    const r = run([eur, { name: 'BTC', blocks: [block('fiat-in')] }], {});
    expect(r.fiat).toEqual([eur]);
    expect(r.unrecognised).toEqual([]);
    expect(r.summary['not-recognised']).toBe(0);
    expect(r.rows.map((x) => x.symbol)).toEqual(['BTC']);
  });

  it('counts verdicts in the summary', () => {
    const r = run(
      [
        {
          name: 'BTC',
          blocks: [block('fiat-in'), block('fiat-out'), block('rrpt')],
        },
      ],
      { [BTC]: { 'fiat-in': own(), 'crypto-in': own() } },
    );
    expect(r.summary).toEqual({
      match: 1,
      differs: 0,
      'missing-own': 1,
      'not-reported': 1,
      unpriced: 0,
      'not-compared': 1,
      'not-recognised': 0,
    });
  });

  it('sorts by symbol then category order', () => {
    const r = run(
      [
        { name: 'ETH', blocks: [block('crypto-out'), block('fiat-in')] },
        { name: 'BTC', blocks: [block('wallet'), block('transfer-in')] },
      ],
      { [BTC]: { 'fiat-out': own() } },
    );
    expect(r.rows.map((x) => `${x.symbol}/${x.category}`)).toEqual([
      'BTC/fiat-out',
      'BTC/transfer-in',
      'BTC/wallet',
      'ETH/fiat-in',
      'ETH/crypto-out',
    ]);
  });

  it('copies the header fields', () => {
    const r = run([], {});
    expect(r).toMatchObject({
      messageRefId: 'M1',
      messageTypeIndic: 'CARF701',
      reportingPeriod: '2026-12-31',
      year: 2026,
      timestamp: '2027-03-15T10:20:30',
      provider: 'Bitpanda GmbH',
      sourceIds: ['s1'],
      sourceLabels: ['Bitpanda'],
      fileHash: 'abc123',
      baseCurrency: 'eur',
      user: {
        name: 'Erika Mustermann',
        tins: [{ value: '123', issuedBy: 'DE' }],
        docRefId: 'D1',
        docTypeIndic: 'OECD1',
      },
    });
  });

  it('passes the fiat fees through and converts fees to whole units', () => {
    const row = one(block('fiat-in'), own({ fees: '10000', fiatFees: '1.5' }));
    expect(row.own?.fees).toBe('0.0001');
    expect(row.own?.fiatFees).toBe('1.5');
  });
});

const HEADER =
  'asset,category,verdict,reportedTransactions,reportedUnits,reportedAmount,reportedCurrency,ownTransactions,ownUnits,ownAmount,ownFees,ownFiatFees,deltaTransactions,deltaUnits,deltaAmount,provider,messageRefId,reportingPeriod,fileHash,baseCurrency';

const linesOf = (csv: string): string[] => {
  const lines = csv.split('\r\n');
  expect(lines.pop()).toBe('');
  return lines;
};

describe('reconciliationToCsv', () => {
  it('writes the header, rows and unrecognised assets', () => {
    const r = run(
      [
        { name: 'BTC', blocks: [block('fiat-in', { transactions: 2 })] },
        {
          name: 'NIGHT',
          blocks: [block('wallet', { transactions: undefined })],
        },
      ],
      { [BTC]: { 'fiat-in': own({ fees: '10000', fiatFees: '2.5' }) } },
    );
    const lines = linesOf(reconciliationToCsv(r));
    expect(lines[0]).toBe(HEADER);
    expect(lines[1].split(',')).toEqual([
      'BTC',
      'fiat-in',
      'differs',
      '2',
      '0.25',
      '15000',
      'EUR',
      '3',
      '0.25',
      '15000',
      '0.0001',
      '2.5',
      '1',
      '0',
      '0',
      'Bitpanda GmbH',
      'M1',
      '2026-12-31',
      'abc123',
      'EUR',
    ]);
    expect(lines[2].split(',')).toEqual([
      'NIGHT',
      'wallet',
      'not-recognised',
      '',
      '0.250000',
      '15000.00',
      'EUR',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'Bitpanda GmbH',
      'M1',
      '2026-12-31',
      'abc123',
      'EUR',
    ]);
    expect(lines).toHaveLength(3);
  });

  it('writes one line for an unrecognised asset without blocks, and the fiat listed', () => {
    const r = run(
      [
        { name: 'MYSTERY', blocks: [] },
        { name: 'USD', blocks: [block('fiat-in', { currency: 'USD' })] },
      ],
      {},
    );
    const lines = linesOf(reconciliationToCsv(r));
    expect(lines).toHaveLength(3);
    expect(lines[1].split(',').slice(0, 4)).toEqual([
      'MYSTERY',
      '',
      'not-recognised',
      '',
    ]);
    expect(lines[2].split(',').slice(0, 3)).toEqual([
      'USD',
      'fiat-in',
      'not-crypto',
    ]);
  });

  it('quotes commas and quotes and ends lines with CRLF', () => {
    const user = userOf([{ name: 'BTC', blocks: [block('fiat-in')] }]);
    const r = reconcile({
      message: messageOf(user, {
        provider: { name: 'Acme, "Ltd"', docRefId: 'P' },
      }),
      user,
      own: {},
      baseCurrency: 'eur',
      fileHash: 'h',
      sources: [],
    });
    const csv = reconciliationToCsv(r);
    expect(csv).toContain('"Acme, ""Ltd"""');
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.split('\r\n')[0]).toBe(HEADER);
  });
});

describe('aggregate and reconcile together', () => {
  it('compares the disposed side of a swap whose acquired side has no value', () => {
    const ADA = 'cardano:lovelace';
    const swap = ledgerEvent({
      id: 'swap',
      externalId: 'swap',
      timestamp: Date.UTC(2026, 4, 1, 12),
      kind: 'trade',
      legs: [
        {
          assetId: BTC,
          amount: '1000000',
          direction: 'out',
          venue: 'bitpanda',
          role: 'principal',
        },
        {
          assetId: ADA,
          amount: '1000000000',
          direction: 'in',
          venue: 'bitpanda',
          role: 'principal',
        },
      ],
    });
    const figures = aggregateLedger([swap], {
      year: 2026,
      providerVenues: new Set(['bitpanda']),
      exchangeVenues: new Set(['bitpanda']),
      baseCurrency: 'eur',
      valueOf: (id, assetId) =>
        id === 'swap' && assetId === BTC ? '600' : undefined,
    });
    const r = run(
      [
        {
          name: 'ADA',
          blocks: [
            block('crypto-in', {
              transactions: 1,
              units: '1000.000000',
              amount: '600.00',
            }),
          ],
        },
        {
          name: 'BTC',
          blocks: [
            block('crypto-out', {
              transactions: 1,
              units: '0.010000',
              amount: '600.00',
            }),
          ],
        },
      ],
      figures,
    );
    const byKey = Object.fromEntries(
      r.rows.map((row) => [`${row.symbol}/${row.category}`, row]),
    );
    expect(byKey['ADA/crypto-in'].verdict).toBe('unpriced');
    expect(byKey['ADA/crypto-in'].own?.amount).toBeUndefined();
    expect(byKey['BTC/crypto-out'].verdict).toBe('match');
    expect(byKey['BTC/crypto-out'].delta.amount).toBe('0');
  });
});

describe('sha256Hex', () => {
  it('hashes the UTF-8 bytes to lower-case hex', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
