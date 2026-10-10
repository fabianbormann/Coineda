import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ledgerLiveCsv from '@/sources/ledger-live-csv';
import krakenCsv from '@/sources/kraken-csv';
import binanceCsv from '@/sources/binance-csv';
import coinbaseCsv from '@/sources/coinbase-csv';
import { detectFileModule } from '@/sources/csv/registry';
import { importFile } from '@/sources/csv/importFile';
import { foldHoldings, ownedVenuesOf } from '@/ledger/balances';
import { getAllEvents, getSources, openLedger } from '@/ledger/db';
import { USDT_ASSET_ID } from '@/prices/scale';
import type { LedgerEvent } from '@/ledger/types';

let FIXTURE: string;
let KRAKEN: string;

beforeAll(async () => {
  const read = (file: string) =>
    readFile(path.join(__dirname, '..', 'src', 'sources', file), 'utf8');
  FIXTURE = await read('ledger-live-csv/fixtures/operations.csv');
  KRAKEN = await read('kraken-csv/fixtures/ledgers.csv');
});

const ETH_VENUE = 'ledger-live:0xabcdef0123456789abcdef0123456789abcdef01';

describe('Ledger Live sniff', () => {
  it('recognises its own header and nobody else’s', () => {
    expect(ledgerLiveCsv.sniff(FIXTURE)).toBe(true);
    expect(detectFileModule(FIXTURE)?.manifest.id).toBe('ledger-live-csv');
    for (const other of [krakenCsv, binanceCsv, coinbaseCsv]) {
      expect(other.sniff(FIXTURE)).toBe(false);
    }
    expect(ledgerLiveCsv.sniff(KRAKEN)).toBe(false);
    expect(ledgerLiveCsv.sniff('garbage')).toBe(false);
  });
});

describe('Ledger Live parse', () => {
  const events = () => ledgerLiveCsv.parse(FIXTURE).events;
  const byHash = (hash: string) => events().filter((e) => e.txHash === hash);

  it('produces nine events', () => {
    expect(events()).toHaveLength(9);
  });

  it('books an incoming BTC operation as a transfer in', () => {
    const [e] = byHash('aaa111');
    expect(e.kind).toBe('transfer');
    expect(e.legs).toEqual([
      {
        assetId: 'bitcoin:native',
        amount: '50000000',
        direction: 'in',
        venue: 'ledger-live:xpub6BtcExample',
        role: 'principal',
      },
    ]);
  });

  it('books an outgoing BTC operation net of its fee, plus the fee leg', () => {
    // Ledger's OUT amount INCLUDES the fee (types-live operation.ts), so the
    // principal sent is 0.1 - 0.0001.
    const [e] = byHash('bbb222');
    expect(e.kind).toBe('transfer');
    expect(e.legs.map((l) => [l.role, l.direction, l.amount])).toEqual([
      ['principal', 'out', '9990000'],
      ['fee', 'out', '10000'],
    ]);
  });

  it('books an ETH OUT whose amount is all fee as a fee event on the lower-cased venue', () => {
    const e = events().find((x) => x.txHash === 'ccc333' && x.kind === 'fee')!;
    expect(e.legs).toEqual([
      {
        assetId: 'eth:native',
        amount: '2000000000000000',
        direction: 'out',
        venue: ETH_VENUE,
        role: 'fee',
      },
    ]);
  });

  it('books a token OUT with no fee leg', () => {
    const e = events().find(
      (x) => x.txHash === 'ccc333' && x.kind === 'transfer',
    )!;
    expect(e.legs).toEqual([
      {
        assetId: USDT_ASSET_ID,
        amount: '250000000',
        direction: 'out',
        venue: ETH_VENUE,
        role: 'principal',
      },
    ]);
  });

  it('books staking rewards', () => {
    const [e] = byHash('ddd444');
    expect(e.kind).toBe('reward');
    expect(e.rewardKind).toBe('staking');
    expect(e.legs[0].amount).toBe('12300000');
  });

  it('books chain actions with a fee as fee events', () => {
    expect(byHash('eee555')[0].kind).toBe('fee');
    expect(byHash('eee555')[0].legs[0].amount).toBe('156000000');
    expect(byHash('fff666')[0].kind).toBe('fee');
    expect(byHash('fff666')[0].legs).toHaveLength(1);
    expect(byHash('fff666')[0].legs[0].amount).toBe('5000');
  });

  it('keeps only the fee of a failed operation', () => {
    const [e] = byHash('hhh888');
    expect(e.kind).toBe('fee');
    expect(e.legs).toHaveLength(1);
    expect(e.legs[0].amount).toBe('20000');
  });

  it('reads a decimal comma', () => {
    expect(byHash('iii999')[0].legs[0].amount).toBe('1250000000');
  });

  it('skips NFTs by reason and governance without a fee silently', () => {
    const { skipped } = ledgerLiveCsv.parse(FIXTURE);
    expect(skipped.filter((s) => /NFT_IN operations/.test(s))).toHaveLength(1);
    expect(skipped.some((s) => /VOTE/.test(s))).toBe(false);
  });

  it('skips an unparseable amount with a counted reason', () => {
    const bad = FIXTURE.replace('"1,25",0,iii999', '"1.234,5",0,iii999');
    const { events: e, skipped } = ledgerLiveCsv.parse(bad);
    expect(e).toHaveLength(8);
    expect(skipped.some((s) => /unparseable amounts/.test(s))).toBe(true);
  });

  it('has stable unique external ids', () => {
    const a = events().map((e) => e.externalId);
    expect(new Set(a).size).toBe(a.length);
    expect(a).toEqual(
      ledgerLiveCsv.parse(FIXTURE).events.map((e) => e.externalId),
    );
  });

  it('folds BTC to what is left', () => {
    const ledger = events().map((e, i) => ({
      ...e,
      id: `e${i}`,
      sourceId: 's',
    })) as LedgerEvent[];
    const held = foldHoldings(ledger, ownedVenuesOf(ledger));
    const btc = held.find((h) => h.assetId === 'bitcoin:native');
    // 0.5 in, 0.1 out including its 0.0001 fee, a failed send's 0.0002 fee.
    expect(btc?.amount).toBe('39980000');
  });

  it('refuses a wrong header, naming the columns found', () => {
    expect(() => ledgerLiveCsv.parse('alpha,beta\n1,2\n')).toThrow(/alpha/);
  });
});

describe('Ledger Live import', () => {
  beforeEach(async () => {
    const db = await openLedger();
    for (const store of ['events', 'sources', 'cursors'] as const) {
      await db.clear(store);
    }
  });

  it('inserts nine and converges on re-import', async () => {
    const first = await importFile(FIXTURE);
    expect(first.inserted).toBe(9);
    const again = await importFile(FIXTURE);
    expect(again.inserted).toBe(0);
    expect(again.updated).toBe(9);
    const sources = await getSources();
    expect(sources).toHaveLength(1);
    expect(sources[0].moduleId).toBe('ledger-live-csv');
    expect(await getAllEvents()).toHaveLength(9);
  });
});

describe('Ledger Live fix round 1', () => {
  const HEAD = FIXTURE_HEAD();
  function FIXTURE_HEAD() {
    return 'Operation Date,Status,Currency Ticker,Operation Type,Operation Amount,Operation Fees,Operation Hash,Account Name,Account xpub,Countervalue Ticker,Countervalue at Operation Date,Countervalue at CSV Export\r\n';
  }
  const ETH = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
  const run = (...rows: string[]) =>
    ledgerLiveCsv.parse(HEAD + rows.join('\r\n') + '\r\n');

  it('never books a fee leg on a token row', () => {
    const { events } = run(
      `2025-03-05T12:00:00.000Z,Confirmed,USDT,OUT,250,0.002,t1,Tether,${ETH},EUR,0,0`,
    );
    expect(events).toHaveLength(1);
    expect(events[0].legs).toHaveLength(1);
    expect(events[0].legs[0].role).toBe('principal');
  });

  it('keeps identical flattened rows apart, stably', () => {
    const row = `2025-03-05T12:00:00.000Z,Confirmed,ETH,IN,1,0,h1,Ethereum 1,${ETH},EUR,0,0`;
    const a = run(row, row).events.map((e) => e.externalId);
    expect(a).toHaveLength(2);
    expect(a[0]).not.toBe(a[1]);
    expect(run(row, row).events.map((e) => e.externalId)).toEqual(a);
    expect(run(row).events[0].externalId).toBe(a[0]);
  });

  it('falls back to the account name, then skips', () => {
    const named = run(
      '2025-03-05T12:00:00.000Z,Confirmed,BTC,IN,1,0,h2,Bitcoin 1,,EUR,0,0',
    );
    expect(named.events[0].legs[0].venue).toBe('ledger-live:name:Bitcoin 1');
    const none = run(
      '2025-03-05T12:00:00.000Z,Confirmed,BTC,IN,1,0,h3,,,EUR,0,0',
    );
    expect(none.events).toHaveLength(0);
    expect(none.skipped.some((s) => /rows without an account/.test(s))).toBe(
      true,
    );
  });

  it('skips a row whose amount is not a number instead of aborting', () => {
    const { events, skipped } = run(
      '2025-03-05T12:00:00.000Z,Confirmed,BTC,IN,abc,0,h5,Bitcoin 1,xpub1,EUR,0,0',
      '2025-03-05T12:00:00.000Z,Confirmed,BTC,IN,1,0,h6,Bitcoin 1,xpub1,EUR,0,0',
    );
    expect(events).toHaveLength(1);
    expect(skipped).toContain('Skipped unparseable amounts in BTC');
  });

  it('books a native OUT net of its fee and a token OUT as it stands', () => {
    const { events } = run(
      `2025-03-05T12:00:00.000Z,Confirmed,ETH,OUT,1,0.01,n1,Ethereum 1,${ETH},EUR,0,0`,
      `2025-03-05T12:00:00.000Z,Confirmed,USDT,OUT,250,,n1,Tether,${ETH},EUR,0,0`,
    );
    expect(events[0].legs.map((l) => [l.role, l.amount])).toEqual([
      ['principal', '990000000000000000'],
      ['fee', '10000000000000000'],
    ]);
    expect(events[1].legs.map((l) => [l.role, l.amount])).toEqual([
      ['principal', '250000000'],
    ]);
  });

  it('books a native OUT whose amount equals its fee as a fee only', () => {
    const { events } = run(
      `2025-03-05T12:00:00.000Z,Confirmed,ETH,OUT,0.002,0.002,n2,Ethereum 1,${ETH},EUR,0,0`,
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('fee');
    expect(events[0].legs.map((l) => [l.role, l.amount])).toEqual([
      ['fee', '2000000000000000'],
    ]);
  });

  it('skips a native OUT whose amount is below its fee', () => {
    const { events, skipped } = run(
      `2025-03-05T12:00:00.000Z,Confirmed,ETH,OUT,0.001,0.002,n3,Ethereum 1,${ETH},EUR,0,0`,
    );
    expect(events).toHaveLength(0);
    expect(skipped).toContain('Skipped amounts below the fee');
  });

  it('resolves a native ticker before any token, whatever the address', () => {
    const at = (ticker: string, account: string) =>
      run(
        `2025-03-05T12:00:00.000Z,Confirmed,${ticker},IN,1,0,r-${ticker},Acc,${account},EUR,0,0`,
      );
    expect(at('POL', ETH).events[0].legs[0].assetId).toBe('polygon:native');
    expect(at('BNB', ETH).events[0].legs[0].assetId).toBe('bnb:native');
    expect(at('USDT', ETH).events[0].legs[0].assetId).toBe(USDT_ASSET_ID);
  });

  it('skips a token on an account that is not an 0x address', () => {
    const tron = run(
      '2025-03-05T12:00:00.000Z,Confirmed,USDT,IN,10,0,t-tron,Tron 1,TXyzTronAddress,EUR,0,0',
    );
    expect(tron.events).toHaveLength(0);
    expect(tron.skipped).toContain('Skipped holdings in USDT');
    const solana = run(
      '2025-03-05T12:00:00.000Z,Confirmed,USDC,IN,10,0,t-sol,Solana 1,SoLExampleAddress,EUR,0,0',
    );
    expect(solana.events).toHaveLength(0);
    expect(solana.skipped).toContain('Skipped holdings in USDC');
  });

  it('skips an ambiguous MATIC on an 0x account with a reason', () => {
    const { events, skipped } = run(
      `2025-03-05T12:00:00.000Z,Confirmed,MATIC,IN,1,0,m1,Polygon 1,${ETH},EUR,0,0`,
    );
    expect(events).toHaveLength(0);
    expect(skipped).toContain('Skipped holdings in MATIC');
  });

  it('books the fee of a REDELEGATE', () => {
    const { events } = run(
      '2025-03-05T12:00:00.000Z,Confirmed,DOT,REDELEGATE,0,0.01,h4,Polkadot 1,1Dot,EUR,0,0',
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('fee');
    expect(events[0].legs[0].amount).toBe('100000000');
  });
});
