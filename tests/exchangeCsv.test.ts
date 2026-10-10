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
import { toBaseUnits, UnscalableAmountError } from '@/sources/csv/ledgerShape';
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

  it('strips commas only when they are thousands groups', () => {
    expect(toBaseUnits('t', '1,234.5', 'bitcoin:native')).toBe('123450000000');
    expect(toBaseUnits('t', '-12,345,678', 'fiat:eur')).toBe('-12345678');
  });

  it('refuses any other comma, naming the value', () => {
    // '0,01' is a decimal comma: stripping it would book one BTC for a
    // hundredth of one.
    for (const value of [
      '0,01',
      '1,5',
      '12,34,5',
      '12,345,6',
      ',5',
      // A leading zero group is a decimal comma too: "0,010" is a
      // hundredth, not a thousands-grouped ten.
      '0,010',
      '0,123',
    ]) {
      expect(() => toBaseUnits('t', value, 'bitcoin:native')).toThrow(
        UnscalableAmountError,
      );
      expect(() => toBaseUnits('t', value, 'bitcoin:native')).toThrow(value);
    }
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

  it('refuses a Binance export re-saved by a German Excel', () => {
    // Semicolons between fields and decimal commas inside them. Before the
    // delimiter sniff this file was one header cell and was refused; it must
    // stay refused rather than parse '0,01000000' as 1000000 BTC.
    const german = BINANCE.split(/\r?\n/)
      .map((line) =>
        line
          .split(',')
          .map((field) => field.replace(/^(-?\d+)\.(\d+)$/, '$1,$2'))
          .join(';'),
      )
      .join('\n');
    expect(german).toContain(';BTC;0,01000000;');
    expect(binanceCsv.sniff(german)).toBe(false);
    expect(detectFileModule(german)?.manifest.id).not.toBe('binance-csv');
    expect(() => binanceCsv.parse(german)).toThrow(/carried/);

    const original = binanceCsv.parse(BINANCE).events.flatMap((e) => e.legs);
    const largest = original.reduce(
      (max, leg) => (new Big(leg.amount).gt(max) ? new Big(leg.amount) : max),
      new Big(0),
    );
    let parsed: { legs: { amount: string }[] }[] = [];
    try {
      parsed = binanceCsv.parse(german).events;
    } catch {
      // Refused: the outcome this test wants.
    }
    for (const leg of parsed.flatMap((e) => e.legs)) {
      expect(new Big(leg.amount).lt(largest.times(1000))).toBe(true);
    }
  });

  it('skips a quoted decimal-comma change instead of stripping it', () => {
    const file =
      'User_ID,UTC_Time,Account,Operation,Coin,Change,Remark\n' +
      '1,2024-03-10 14:22:51,Spot,Deposit,BTC,"0,01000000",\n' +
      '1,2024-03-10 14:22:52,Spot,Deposit,BTC,"1,234.5",\n';
    const { events, skipped } = binanceCsv.parse(file);
    expect(events.map((e) => e.legs[0].amount)).toEqual(['123450000000']);
    expect(skipped).toContain('Skipped rows with an unreadable change');
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

  it('pairs the Spend, Buy and Fee rows of one trade into a single event', () => {
    // Three rows share a timestamp and account: one trade, not three
    // one-legged events.
    const { events, supersedes } = binanceCsv.parse(BINANCE);
    const trade = events.find((event) => event.kind === 'trade');
    expect(trade?.externalId).toBe('2024-03-11 09:05:00#Spot#trade');
    expect(trade?.timestamp).toBe(Date.UTC(2024, 2, 11, 9, 5));
    expect(trade?.legs).toEqual([
      {
        assetId: 'fiat:eur',
        amount: '500',
        direction: 'out',
        venue: 'Spot',
        role: 'principal',
      },
      {
        assetId: 'bitcoin:native',
        amount: '1000000',
        direction: 'in',
        venue: 'Spot',
        role: 'principal',
      },
      {
        assetId: 'bitcoin:native',
        amount: '1000',
        direction: 'out',
        venue: 'Spot',
        role: 'fee',
      },
    ]);
    expect(events.filter((event) => event.kind === 'trade')).toHaveLength(1);
    // The per-row ids the old parser wrote for the three rows (row index 1,
    // 2 and 3 of the data).
    expect(supersedes).toEqual([
      `${Date.UTC(2024, 2, 11, 9, 5)}#1#EUR`,
      `${Date.UTC(2024, 2, 11, 9, 5)}#2#BTC`,
      `${Date.UTC(2024, 2, 11, 9, 5)}#3#BTC`,
    ]);
  });

  it('books a trade row with no counterparty as a transfer, not a one-legged trade', () => {
    const { events } = binanceCsv.parse(BINANCE);
    const lone = events.find((event) =>
      event.legs.some((leg) => leg.assetId.toLowerCase().includes('doge')),
    );
    expect(lone?.kind).toBe('transfer');
    expect(lone?.note?.endsWith('unpaired trade row')).toBe(true);
    expect(lone?.legs).toHaveLength(1);
    expect(lone?.legs[0].direction).toBe('in');
  });

  it('leaves two same-second trades ungrouped and says so', () => {
    const h = 'User_ID,UTC_Time,Account,Operation,Coin,Change,Remark\n';
    const at = '2024-03-11 09:05:00,Spot';
    const { events, skipped } = binanceCsv.parse(
      h +
        `1,${at},Transaction Spend,EUR,-500,\n` +
        `1,${at},Transaction Buy,BTC,0.01,\n` +
        `1,${at},Transaction Spend,EUR,-300,\n` +
        `1,${at},Transaction Buy,ETH,0.1,\n` +
        `1,${at},Transaction Fee,BTC,-0.00001,\n`,
    );
    expect(events.map((e) => e.kind)).toEqual([
      'transfer',
      'transfer',
      'transfer',
      'transfer',
      'fee',
    ]);
    expect(events.every((e) => e.note?.endsWith('ambiguous trade rows'))).toBe(
      true,
    );
    expect(skipped).toContain(
      'Skipped ambiguous same-second trade rows'.replace(
        'Skipped ',
        'Skipped 5 ',
      ),
    );
  });

  it('still groups same-asset partial fills into one trade', () => {
    const h = 'User_ID,UTC_Time,Account,Operation,Coin,Change,Remark\n';
    const at = '2024-03-11 09:05:00,Spot';
    const { events } = binanceCsv.parse(
      h +
        `1,${at},Transaction Spend,EUR,-500,\n` +
        `1,${at},Transaction Buy,BTC,0.006,\n` +
        `1,${at},Transaction Buy,BTC,0.004,\n`,
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('trade');
    expect(events[0].legs).toHaveLength(3);
  });

  it('does not pair two trade rows that both move the same way', () => {
    const { events, supersedes } = binanceCsv.parse(
      'User_ID,UTC_Time,Account,Operation,Coin,Change,Remark\n' +
        '1,2024-03-11 09:05:00,Spot,Transaction Buy,BTC,0.01,\n' +
        '1,2024-03-11 09:05:00,Spot,Transaction Buy,ETH,0.5,\n',
    );
    expect(events.map((event) => event.kind)).toEqual(['transfer', 'transfer']);
    expect(supersedes ?? []).toEqual([]);
  });

  it('skips an operation it has no rule for rather than guessing', () => {
    // Binance has well over a hundred operation names. Guessing turns a
    // margin interest charge into a disposal.
    const { skipped } = binanceCsv.parse(BINANCE);
    expect(skipped.join(' ')).toMatch(/mystery operation/i);
    expect(skipped.join(' ')).not.toMatch(/DOGE/); // DOGE now resolves via the catalogue
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

  it('scales a thousands-grouped subtotal and skips a decimal-comma one', () => {
    const header =
      'ID,Timestamp,Transaction Type,Asset,Quantity Transacted,Price Currency,Price at Transaction,Subtotal,Total (inclusive of fees and/or spread),Fees and/or Spread,Notes';
    const inline = coinbaseCsv.parse(
      [
        'preamble',
        '',
        header,
        'g-1,2024-07-01T00:00:00Z,Buy,BTC,1.0,EUR,1234.56,"1,234.56","1,236.06",1.50,',
        'g-2,2024-07-02T00:00:00Z,Buy,BTC,1.0,EUR,1234.56,"1.234,56","1.236,06","1,50",',
      ].join('\n'),
    );
    expect(inline.events.map((e) => e.externalId)).toEqual(['g-1']);
    expect(
      inline.events[0].legs.find((leg) => leg.assetId === 'fiat:eur')?.amount,
    ).toBe('1234.56');
    expect(inline.skipped.join(' ')).toMatch(/unparseable amounts/);
  });

  it('emits a trade whose unused Total column is garbled', () => {
    const header =
      'ID,Timestamp,Transaction Type,Asset,Quantity Transacted,Price Currency,Price at Transaction,Subtotal,Total (inclusive of fees and/or spread),Fees and/or Spread,Notes';
    const { events } = coinbaseCsv.parse(
      [
        'preamble',
        '',
        header,
        't-1,2024-07-01T00:00:00Z,Buy,BTC,1.0,EUR,500,500.00,"5,00,1",1.50,',
      ].join('\n'),
    );
    expect(events.map((e) => e.externalId)).toEqual(['t-1']);
    expect(events[0].legs).toHaveLength(3);
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
    expect(skipped.join(' ')).not.toMatch(/DOGE/); // DOGE now resolves via the catalogue
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

  it('gives each grouped wallet transfer its own id, even in the same second', () => {
    const at = '2025-03-10 10:00:00';
    const op = 'Transfer Between Main and Futures Wallet';
    const pair = (n: number) => [
      `1,${at},Spot,${op},USDT,-${n},`,
      `1,${at},${futures},${op},USDT,${n},`,
    ];
    const different = binanceCsv.parse(csvOf(...pair(100), ...pair(50)));
    expect(different.events).toHaveLength(2);
    expect(new Set(different.events.map((e) => e.externalId)).size).toBe(2);
    const identical = binanceCsv.parse(csvOf(...pair(100), ...pair(100)));
    expect(identical.events).toHaveLength(2);
    expect(new Set(identical.events.map((e) => e.externalId)).size).toBe(2);
    expect(identical.events.every((e) => e.legs.length === 2)).toBe(true);
  });

  it('treats a positive futures commission as a received principal', () => {
    const { events } = binanceCsv.parse(
      csvOf(`1,2025-03-10 10:00:00,${futures},Commission,USDT,0.05,`),
    );
    expect(events[0].kind).toBe('derivative');
    expect(events[0].derivative).toEqual({
      kind: 'commission',
      product: 'futures',
    });
    expect(events[0].legs).toHaveLength(1);
    expect(events[0].legs[0].direction).toBe('in');
    expect(events[0].legs[0].role).toBe('principal');
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

describe('resolving tickers through the asset catalogue', () => {
  it('Binance resolves a catalogue-only ticker the old map skipped', () => {
    const row = '12345678,2024-10-01 00:00:00,Spot,Deposit,SOL,2.00000000,\n';
    const { events } = binanceCsv.parse(BINANCE + row);
    expect(
      events.some((event) =>
        event.legs.some((leg) => leg.assetId === 'solana:native'),
      ),
    ).toBe(true);
  });

  it('Coinbase resolves a catalogue-only ticker the old map skipped', () => {
    const row =
      'abc-9,2024-10-01T00:00:00Z,Receive,SOL,2.00000000,EUR,,,,,Received\n';
    const { events } = coinbaseCsv.parse(COINBASE + row);
    expect(
      events.some((event) =>
        event.legs.some((leg) => leg.assetId === 'solana:native'),
      ),
    ).toBe(true);
  });
});

describe('fiat other than euro in the exchange importers', () => {
  it('Coinbase books a USD-priced buy with a fiat:usd counter and fee leg', () => {
    const row =
      'abc-10,2024-10-01T00:00:00Z,Buy,BTC,0.01000000,USD,50000.00,500.00,501.50,1.50,Bought\n';
    const { events } = coinbaseCsv.parse(COINBASE + row);
    const bought = events.find((event) => event.externalId === 'abc-10');
    expect(bought?.legs).toEqual([
      {
        assetId: 'bitcoin:native',
        amount: '1000000',
        direction: 'in',
        venue: 'coinbase',
        role: 'principal',
      },
      {
        assetId: 'fiat:usd',
        amount: '500',
        direction: 'out',
        venue: 'coinbase',
        role: 'principal',
      },
      {
        assetId: 'fiat:usd',
        amount: '1.5',
        direction: 'out',
        venue: 'coinbase',
        role: 'fee',
      },
    ]);
  });

  it('Binance books a USD fiat deposit as fiat-in, in whole units with cents', () => {
    const row =
      '12345678,2024-10-01 00:00:00,Spot,Fiat Deposit,USD,100.25000000,\n';
    const { events } = binanceCsv.parse(BINANCE + row);
    const deposit = events.find(
      (event) =>
        event.kind === 'fiat-in' &&
        event.legs.some((leg) => leg.assetId === 'fiat:usd'),
    );
    expect(deposit?.legs).toHaveLength(1);
    expect(deposit?.legs[0]).toMatchObject({
      assetId: 'fiat:usd',
      amount: '100.25',
      direction: 'in',
    });
  });
});
