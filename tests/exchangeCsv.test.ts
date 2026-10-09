import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Big from 'big.js';
import binanceCsv from '@/sources/binance-csv';
import coinbaseCsv from '@/sources/coinbase-csv';
import { BINANCE_ASSETS, parseBinanceTime } from '@/sources/binance-csv/parse';
import { findHeaderRow } from '@/sources/coinbase-csv/parse';
import { readCsvRows } from '@/sources/csv/readCsv';
import { detectFileModule } from '@/sources/csv/registry';
import { toBaseUnits } from '@/sources/csv/ledgerShape';
import {
  foldHoldings,
  isInternalTransfer,
  ownedVenuesOf,
} from '@/ledger/balances';
import type { LedgerEvent } from '@/ledger/types';

/**
 * Binance and Coinbase, by file, for the same reason as Kraken: neither
 * private API is reachable from a browser.
 *
 * NEITHER parser has been run against a real export. Their column sets are
 * the providers' documented ones, required by name, and a file that does
 * not carry them is refused with the columns it did carry - so a first run
 * produces a precise bug report rather than silent garbage. That stance is
 * what made the Bitpanda module's first live run find two real problems
 * inside an hour.
 */
let BINANCE: string;
let COINBASE: string;

beforeAll(async () => {
  const read = (file: string) =>
    readFile(path.join(__dirname, '..', 'src', 'sources', file), 'utf8');
  BINANCE = await read('binance-csv/fixtures/transactions.csv');
  COINBASE = await read('coinbase-csv/fixtures/transactions.csv');
});

const ledger = (events: { legs: unknown }[]): LedgerEvent[] =>
  events.map((event, index) => ({
    ...(event as LedgerEvent),
    id: `e${index}`,
    sourceId: 's1',
  }));

describe('the shared unit boundary', () => {
  it('scales whole units into base units', () => {
    // The error that has threatened this codebase four times: 0.01 BTC is
    // 1000000 satoshis, and storing 0.01 understates it a hundred million
    // fold.
    expect(toBaseUnits('t', '0.01000000', 'bitcoin:native')).toBe('1000000');
    expect(toBaseUnits('t', '2.5', 'cardano:lovelace')).toBe('2500000');
    // Fiat keeps its cents.
    expect(toBaseUnits('t', '1.50', 'fiat:eur')).toBe('1.5');
  });

  it('refuses an asset it cannot scale rather than defaulting to 1:1', () => {
    expect(() => toBaseUnits('t', '1', 'cardano:somepolicy')).toThrow(
      /decimals/,
    );
  });
});

describe('detecting which exchange a file came from', () => {
  it('tells the three formats apart by their headers', async () => {
    expect(detectFileModule(BINANCE)?.manifest.id).toBe('binance-csv');
    expect(detectFileModule(COINBASE)?.manifest.id).toBe('coinbase-csv');
  });

  it('still refuses a file none of them recognise', () => {
    expect(detectFileModule('alpha,beta\n1,2\n')).toBeNull();
  });
});

describe('Binance', () => {
  it('reads a zoneless UTC_Time as UTC', () => {
    // The column is literally called UTC_Time, and Date.parse on a
    // space-separated zoneless string reads LOCAL time - moving every row
    // by the machine's offset and, at a year boundary, into another tax
    // year. The suite's pinned timezone makes a regression fail here.
    expect(parseBinanceTime('2024-03-10 14:22:51')).toBe(
      Date.UTC(2024, 2, 10, 14, 22, 51),
    );
  });

  it('takes the direction from the sign Binance writes', () => {
    const { events } = binanceCsv.parse(BINANCE);
    const spend = events.find((event) => event.note?.includes('spend'));
    expect(spend?.legs[0]).toMatchObject({
      assetId: 'fiat:eur',
      amount: '500',
      direction: 'out',
    });
    const bought = events.find((event) => event.note?.includes('buy'));
    expect(bought?.legs[0]).toMatchObject({
      assetId: 'bitcoin:native',
      amount: '1000000',
      direction: 'in',
    });
  });

  it('marks a fee operation as a FEE leg, not a disposal', () => {
    // A jurisdiction's internal-transfer test deliberately ignores fee
    // legs, so mislabelling one turns a transfer into a disposal.
    const { events } = binanceCsv.parse(BINANCE);
    const fee = events.find((event) => event.note?.includes('fee'));
    expect(fee?.legs[0]).toMatchObject({ role: 'fee', direction: 'out' });
  });

  it('skips an operation it has no rule for rather than guessing', () => {
    // Binance has well over a hundred operation names. Guessing turns a
    // margin interest charge into a disposal.
    const { skipped } = binanceCsv.parse(BINANCE);
    expect(skipped.join(' ')).toMatch(/mystery operation/i);
    expect(skipped.join(' ')).toMatch(/DOGE/);
  });

  it('names the kind of every reward', () => {
    const { events } = binanceCsv.parse(BINANCE);
    const rewards = events.filter((event) => event.kind === 'reward');
    expect(rewards.length).toBeGreaterThan(0);
    expect(rewards.every((event) => event.rewardKind !== undefined)).toBe(true);
    expect(rewards.find((e) => e.note?.includes('staking'))?.rewardKind).toBe(
      'staking',
    );
    const header = 'User_ID,UTC_Time,Account,Operation,Coin,Change,Remark';
    const inline = binanceCsv.parse(
      [
        header,
        '1,2024-07-01 00:00:00,Spot,Distribution,ADA,1.0,',
        '1,2024-07-02 00:00:00,Earn,Simple Earn Flexible Interest,ADA,1.0,',
        '1,2024-07-03 00:00:00,Spot,Commission,ADA,1.0,',
      ].join('\n'),
    );
    expect(inline.events.map((e) => [e.kind, e.rewardKind])).toEqual([
      ['reward', 'airdrop'],
      ['reward', 'lending'],
      ['reward', 'other'],
    ]);
    // Only rewards carry one.
    expect(
      events
        .filter((event) => event.kind !== 'reward')
        .every((event) => event.rewardKind === undefined),
    ).toBe(true);
  });

  it('folds to what the file actually says', () => {
    const { events } = binanceCsv.parse(BINANCE);
    const held = foldHoldings(ledger(events), ownedVenuesOf(ledger(events)));
    const byAsset = new Map(held.map((h) => [h.assetId, h.amount]));
    // 0.01 bought, 0.00001 fee, 0.005 withdrawn.
    expect(byAsset.get('bitcoin:native')).toBe(
      new Big('0.00499').times(1e8).toFixed(0),
    );
    expect(byAsset.get('fiat:eur')).toBe('500');
  });

  it('says what it found when handed the wrong file', () => {
    let message = '';
    try {
      binanceCsv.parse('alpha,beta\n1,2\n');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('alpha');
    expect(message).toContain('operation');
  });
});

describe('Coinbase', () => {
  it('finds the header past the preamble', () => {
    // The file opens with account blurb. Reading row one as the header
    // produces a table whose every column is named after a sentence.
    const rows = readCsvRows(COINBASE);
    expect(findHeaderRow(rows)).toBeGreaterThan(0);
  });

  it('takes the direction from the TYPE, because quantities are unsigned', () => {
    // Quantity Transacted is always positive here. A parser trusting a sign
    // would book every sale as a purchase.
    const { events } = coinbaseCsv.parse(COINBASE);
    const sold = events.find((event) => event.externalId === 'abc-4');
    expect(sold?.legs[0]).toMatchObject({
      assetId: 'bitcoin:native',
      direction: 'out',
    });
    const bought = events.find((event) => event.externalId === 'abc-1');
    expect(bought?.legs[0]).toMatchObject({ direction: 'in' });
  });

  it('names the kind of every reward', () => {
    const { events } = coinbaseCsv.parse(COINBASE);
    const rewards = events.filter((event) => event.kind === 'reward');
    expect(rewards.length).toBeGreaterThan(0);
    expect(rewards.every((event) => event.rewardKind !== undefined)).toBe(true);
    expect(rewards.find((e) => e.externalId === 'abc-3')?.rewardKind).toBe(
      'staking',
    );
    const header =
      'ID,Timestamp,Transaction Type,Asset,Quantity Transacted,Price Currency,Price at Transaction,Subtotal,Total (inclusive of fees and/or spread),Fees and/or Spread,Notes';
    const inline = coinbaseCsv.parse(
      [
        'preamble',
        '',
        header,
        'r-1,2024-07-01T00:00:00Z,Rewards Income,ADA,1.0,EUR,0.4,0.4,0.4,0,',
        'r-2,2024-07-02T00:00:00Z,Inflation Reward,ADA,1.0,EUR,0.4,0.4,0.4,0,',
        'r-3,2024-07-03T00:00:00Z,Learning Reward,ADA,1.0,EUR,0.4,0.4,0.4,0,',
      ].join('\n'),
    );
    expect(inline.events.map((e) => [e.kind, e.rewardKind])).toEqual([
      ['reward', 'lending'],
      ['reward', 'staking'],
      ['reward', 'airdrop'],
    ]);
    expect(
      events
        .filter((event) => event.kind !== 'reward')
        .every((event) => event.rewardKind === undefined),
    ).toBe(true);
  });

  it('emits the counter-currency from the same row', () => {
    // Coinbase gives it as a total rather than as its own row. Without it a
    // buy records crypto arriving from nowhere and a later disposal has no
    // cost basis to match against.
    const { events } = coinbaseCsv.parse(COINBASE);
    const bought = events.find((event) => event.externalId === 'abc-1');
    expect(bought?.legs).toEqual([
      {
        assetId: 'bitcoin:native',
        amount: '1000000',
        direction: 'in',
        venue: 'coinbase',
        role: 'principal',
      },
      {
        assetId: 'fiat:eur',
        amount: '500',
        direction: 'out',
        venue: 'coinbase',
        role: 'principal',
      },
      {
        assetId: 'fiat:eur',
        amount: '1.5',
        direction: 'out',
        venue: 'coinbase',
        role: 'fee',
      },
    ]);
  });

  it('uses the subtotal, not the total, as what bought the asset', () => {
    // Subtotal excludes fees; Total includes them. Using Total would count
    // the fee twice - once inside the cost basis and once as a fee leg.
    const { events } = coinbaseCsv.parse(COINBASE);
    const bought = events.find((event) => event.externalId === 'abc-1');
    const paid = bought?.legs.find(
      (leg) => leg.assetId === 'fiat:eur' && leg.role === 'principal',
    );
    expect(paid?.amount).toBe('500'); // not 501.50
  });

  it('keeps Coinbase’s own id, so a re-import converges', () => {
    const { events } = coinbaseCsv.parse(COINBASE);
    expect(events.map((event) => event.externalId)).toContain('abc-1');
    const again = coinbaseCsv.parse(COINBASE);
    expect(again.events.map((e) => e.externalId)).toEqual(
      events.map((e) => e.externalId),
    );
  });

  it('skips a type it has no rule for, and an asset it cannot name', () => {
    const { skipped } = coinbaseCsv.parse(COINBASE);
    expect(skipped.join(' ')).toMatch(/mystery/i);
    expect(skipped.join(' ')).toMatch(/DOGE/);
  });

  it('says what it found when handed the wrong file', () => {
    let message = '';
    try {
      coinbaseCsv.parse('alpha,beta\n1,2\n');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('alpha');
    expect(message).toContain('quantity transacted');
  });
});

describe('Binance futures rows', () => {
  const header = 'User_ID,UTC_Time,Account,Operation,Coin,Change,Remark';
  const csvOf = (...lines: string[]): string => [header, ...lines].join('\n');
  const futures = 'USDⓈ-M Futures';

  it('maps realized pnl, funding and futures commission', () => {
    const { events } = binanceCsv.parse(
      csvOf(
        `1,2025-03-10 10:00:00,${futures},Realized Profit and Loss,USDT,12.5,`,
        `1,2025-03-10 11:00:00,${futures},Funding Fee,USDT,-0.3,`,
        `1,2025-03-10 12:00:00,${futures},Funding Fee,USDT,0.2,`,
        `1,2025-03-10 13:00:00,${futures},Commission,USDT,-0.05,`,
      ),
    );
    expect(events.map((e) => e.kind)).toEqual([
      'derivative',
      'derivative',
      'derivative',
      'derivative',
    ]);
    expect(events.map((e) => e.derivative?.kind)).toEqual([
      'pnl',
      'funding',
      'funding',
      'commission',
    ]);
    expect(events.map((e) => e.legs.map((l) => l.direction))).toEqual([
      ['in'],
      ['out'],
      ['in'],
      ['out'],
    ]);
    expect(events[3].legs).toHaveLength(1);
    expect(events[3].legs[0].role).toBe('fee');
    expect(events[0].legs[0].role).toBe('principal');
  });

  it('leaves a Spot commission as an "other" reward', () => {
    const { events } = binanceCsv.parse(
      csvOf(`1,2025-03-10 10:00:00,Spot,Commission,BTC,0.001,`),
    );
    expect(events[0].kind).toBe('reward');
    expect(events[0].rewardKind).toBe('other');
    expect(events[0].derivative).toBeUndefined();
  });

  it('groups the two rows of a wallet transfer into one internal transfer', () => {
    const at = '2025-03-10 10:00:00';
    const { events } = binanceCsv.parse(
      csvOf(
        `1,${at},Spot,Transfer Between Main and Futures Wallet,USDT,-100,`,
        `1,${at},${futures},Transfer Between Main and Futures Wallet,USDT,100,`,
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('transfer');
    expect(events[0].legs).toHaveLength(2);
    expect(events[0].legs.every((l) => l.role === 'principal')).toBe(true);
    const asLedger = { ...events[0], id: 'e1', sourceId: 's1' } as LedgerEvent;
    expect(isInternalTransfer(asLedger, new Set(['Spot', futures]))).toBe(true);
  });

  it('keeps a lone wallet-transfer row as a per-row transfer', () => {
    const { events } = binanceCsv.parse(
      csvOf(
        `1,2025-03-10 10:00:00,Spot,Transfer Between Main and Futures Wallet,USDT,-100,`,
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('transfer');
    expect(events[0].legs).toHaveLength(1);
  });
});

describe('Binance stablecoins', () => {
  it('maps USDT and USDC to their ERC-20 ids and scales by 6 decimals', () => {
    expect(BINANCE_ASSETS['USDT']).toBe(
      'eth:0xdac17f958d2ee523a2206206994597c13d831ec7',
    );
    expect(BINANCE_ASSETS['USDC']).toBe(
      'eth:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    );
    const { events } = binanceCsv.parse(
      'User_ID,UTC_Time,Account,Operation,Coin,Change,Remark\n' +
        '1,2025-03-10 10:00:00,USDⓈ-M Futures,Realized Profit and Loss,USDT,12.5,',
    );
    expect(events[0].legs[0].assetId).toBe(BINANCE_ASSETS['USDT']);
    expect(events[0].legs[0].amount).toBe('12500000');
  });
});
