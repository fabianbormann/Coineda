import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Big from 'big.js';
import krakenCsv from '@/sources/kraken-csv';
import { parseKrakenTime } from '@/sources/kraken-csv/parse';
import {
  assetIdForCode,
  baseUnits,
  stripWalletSuffix,
} from '@/sources/kraken-csv/assets';
import { readCsv, readCsvRows } from '@/sources/csv/readCsv';
import { detectFileModule } from '@/sources/csv/registry';
import { foldHoldings, ownedVenuesOf } from '@/ledger/balances';
import { importFile, UnknownFileFormatError } from '@/sources/csv/importFile';
import { getAllEvents, getSources, openLedger } from '@/ledger/db';
import { syncSource } from '@/sync/syncSource';
import type { LedgerEvent } from '@/ledger/types';

/**
 * Kraken, by file.
 *
 * Not a convenience: measured against Kraken's own private endpoint from a
 * browser origin, the CORS preflight answers 404 and the response carries
 * no `access-control-allow-origin`, so a direct call is blocked before it
 * is sent. The ledger export is the only way in that does not route a
 * user's API secret through somebody else's server.
 */
let LEDGER: string;

beforeAll(async () => {
  LEDGER = await readFile(
    path.join(__dirname, '../src/sources/kraken-csv/fixtures/ledgers.csv'),
    'utf8',
  );
});

describe('the CSV reader', () => {
  it('keeps a comma inside a quoted field in one column', () => {
    // Splitting on `,` turns one such field into two and shifts every value
    // after it into the wrong column. A shifted row is not a parse error -
    // it is a wrong number that parses perfectly.
    const rows = readCsvRows('"a","b,c","d"\n');
    expect(rows).toEqual([['a', 'b,c', 'd']]);
  });

  it('reads a doubled quote as one literal quote', () => {
    expect(readCsvRows('"say ""hi""",x\n')).toEqual([['say "hi"', 'x']]);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(readCsvRows('"line1\nline2",x\n')).toEqual([['line1\nline2', 'x']]);
  });

  it('reads a last row with no trailing newline', () => {
    expect(readCsvRows('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('strips a UTF-8 BOM off the first column name', () => {
    // It arrives on the first header cell and makes that column
    // unmatchable by name - a difference nothing on screen would show.
    const { header, rows } = readCsv('﻿txid,type\nabc,deposit\n');
    expect(header[0]).toBe('txid');
    expect(rows[0].txid).toBe('abc');
  });

  it('keys rows by column name, not position', () => {
    const { rows } = readCsv('b,a\n2,1\n');
    expect(rows[0]).toEqual({ a: '1', b: '2' });
  });
});

describe('Kraken asset codes', () => {
  it('knows the X and Z prefixed codes a real export uses', () => {
    // Verified against Kraken's own /0/public/Assets: XXBT is bitcoin with
    // altname XBT, and the bare XBT is NOT an asset code. An importer
    // matching on "BTC" or "XBT" recognises nothing in a real ledger.
    expect(assetIdForCode('XXBT')).toBe('bitcoin:native');
    expect(assetIdForCode('XETH')).toBe('eth:native');
    expect(assetIdForCode('ZEUR')).toBe('fiat:eur');
    expect(assetIdForCode('ADA')).toBe('cardano:lovelace');
  });

  it('treats a staking wallet suffix as the same asset', () => {
    // ADA.S is staked ADA. Treating it as a different asset turns every
    // move between a user's own spot and staking wallets into a disposal
    // of one asset and an acquisition of another - a taxable event
    // invented out of a transfer to oneself.
    expect(stripWalletSuffix('ADA.S')).toBe('ADA');
    expect(assetIdForCode('ADA.S')).toBe('cardano:lovelace');
    // `XBT.M` is bitcoin in the opt-in rewards wallet, and it resolves.
    // This line asserted null, on the reading that XBT is an altname and
    // not an asset code - true of /0/public/Assets and false of the ledger
    // export, which writes the plain codes throughout. Measured against a
    // real export, that reading cost 175 of 198 rows. Changed rather than
    // deleted: the suffix rule it was testing still holds, only the
    // premise about which codes exist was wrong.
    expect(assetIdForCode('XBT.M')).toBe('bitcoin:native');
  });

  it('reports a code it cannot name rather than guessing', () => {
    // Kraken lists 855 assets.
    expect(assetIdForCode('XXDG')).toBeNull();
    expect(assetIdForCode('')).toBeNull();
  });

  it('scales whole units into base units', () => {
    // 0.01 BTC is 1000000 satoshis. Storing 0.01 understates the position a
    // hundred million fold.
    expect(baseUnits('0.0100000000', 'bitcoin:native')).toBe('1000000');
    expect(baseUnits('500.000000', 'cardano:lovelace')).toBe('500000000');
    // Fiat keeps its cents: a report losing a cent per row cannot be
    // reconciled.
    expect(baseUnits('1.3000', 'fiat:eur')).toBe('1.3');
  });

  it('refuses an asset it cannot scale rather than defaulting to 1:1', () => {
    expect(() => baseUnits('1', 'cardano:somepolicy')).toThrow(/decimals/);
  });
});

describe('Kraken timestamps', () => {
  it('reads a zoneless Kraken time as UTC', () => {
    // Kraken writes "2024-03-10 14:22:51.1234" with no zone marker.
    // Date.parse on a space-separated zoneless string is
    // implementation-defined and in practice reads LOCAL time, which moves
    // every row by the machine's offset - and at a year boundary into a
    // different tax year. The suite runs in America/New_York precisely so
    // this can fail here.
    expect(parseKrakenTime('2024-03-10 14:22:51.1234')).toBe(
      Date.UTC(2024, 2, 10, 14, 22, 51, 123),
    );
    expect(parseKrakenTime('2025-01-01 00:30:00.0000')).toBe(
      Date.UTC(2025, 0, 1, 0, 30),
    );
  });

  it('reports an unreadable time rather than inventing one', () => {
    expect(Number.isNaN(parseKrakenTime('not a time'))).toBe(true);
  });
});

describe('detecting the format', () => {
  it('recognises a Kraken ledger by its header', async () => {
    expect(detectFileModule(LEDGER)?.manifest.id).toBe('kraken-csv');
  });

  it('matches on content, never on a filename', () => {
    // A user renames a download. An importer that runs on the wrong file
    // produces plausible-looking garbage rather than a refusal.
    expect(detectFileModule('a,b,c\n1,2,3\n')).toBeNull();
    expect(detectFileModule('not csv at all')).toBeNull();
    expect(detectFileModule('')).toBeNull();
  });

  it('refuses the TRADES export, which omits deposits and withdrawals', () => {
    // A balance rebuilt from trades alone is wrong the moment anything is
    // withdrawn - the exact failure this project already hit on Bitpanda.
    const trades =
      '"txid","ordertxid","pair","time","type","ordertype","price","cost","fee","vol","margin","misc","ledgers"\n';
    expect(detectFileModule(trades)).toBeNull();
  });

  it('says what it found when handed the wrong file', () => {
    let message = '';
    try {
      krakenCsv.parse('alpha,beta\n1,2\n');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('alpha');
    expect(message).toContain('beta');
    expect(message).toContain('refid');
  });
});

describe('parsing the ledger', () => {
  const parsed = () => krakenCsv.parse(LEDGER);

  it('emits one event per readable row', () => {
    // Nine rows: two are skipped (an asset with no id, a type with no
    // mapping), leaving seven.
    const { events } = parsed();
    expect(events).toHaveLength(7);
  });

  it('charges the fee as its own leg', () => {
    // Omitting it is how a balance drifts upward by every fee ever paid.
    const { events } = parsed();
    const withdrawal = events.find((event) =>
      event.externalId.startsWith('LOGZRL'),
    );
    expect(withdrawal?.legs).toEqual([
      {
        assetId: 'bitcoin:native',
        amount: '500000',
        direction: 'out',
        venue: 'spot / main',
        role: 'principal',
      },
      {
        assetId: 'bitcoin:native',
        amount: '5000',
        direction: 'out',
        venue: 'spot / main',
        role: 'fee',
      },
    ]);
  });

  it('reads Kraken’s sign as the direction', () => {
    const { events } = parsed();
    const spent = events.find((event) => event.externalId.startsWith('LTFMCX'));
    expect(spent?.legs[0]).toMatchObject({
      assetId: 'fiat:eur',
      amount: '500',
      direction: 'out',
    });
    const received = events.find((event) =>
      event.externalId.startsWith('LPCNTQ'),
    );
    expect(received?.legs[0]).toMatchObject({
      assetId: 'bitcoin:native',
      amount: '1000000',
      direction: 'in',
    });
  });

  it('keeps a staking transfer at two venues, so it nets to nothing', () => {
    // Both wallets are the user's. Folded, the move disappears - which is
    // what keeps a transfer to oneself from reading as a disposal.
    const { events } = parsed();
    const ledger: LedgerEvent[] = events.map((event, index) => ({
      ...event,
      id: `e${index}`,
      sourceId: 'kraken',
    }));
    const held = foldHoldings(ledger, ownedVenuesOf(ledger));
    const ada = held.find((holding) => holding.assetId === 'cardano:lovelace');
    // 500 moved out of spot and into staking, plus 2.5 staking reward.
    expect(ada?.amount).toBe(new Big('2.5').times(1e6).toFixed(0));
  });

  it('gives every event an id that survives a re-import', () => {
    // A longer export re-imported must converge rather than duplicate, and
    // events upsert on (sourceId, externalId). refid alone would have one
    // side of a trade overwrite the other: both rows share it.
    const { events } = parsed();
    const ids = events.map((event) => event.externalId);
    expect(new Set(ids).size).toBe(ids.length);

    const again = krakenCsv.parse(LEDGER);
    expect(again.events.map((event) => event.externalId)).toEqual(ids);
  });

  it('reports what it skipped, grouped rather than one line per row', () => {
    // An export can carry hundreds of rows in the same unsupported asset,
    // and three hundred identical sentences is not a report anybody reads.
    const { skipped } = parsed();
    expect(skipped.join(' ')).toMatch(/XXDG/);
    expect(skipped.join(' ')).toMatch(/mysterytype/);
    expect(skipped).toHaveLength(2);
  });
});

describe('importing into the ledger', () => {
  beforeEach(async () => {
    const db = await openLedger();
    for (const store of ['events', 'sources', 'cursors'] as const) {
      await db.clear(store);
    }
  });

  it('creates a source and writes what the file held', async () => {
    const outcome = await importFile(LEDGER);
    expect(outcome.module.manifest.id).toBe('kraken-csv');
    expect(outcome.inserted).toBe(7);
    expect(outcome.updated).toBe(0);

    const sources = await getSources();
    expect(sources).toHaveLength(1);
    expect(sources[0].moduleId).toBe('kraken-csv');
  });

  it('converges on a re-import instead of doubling the balance', async () => {
    // ONE source per importer, reused. Events upsert on
    // (sourceId, externalId), so importing a longer export covering the
    // same history rewrites what it already wrote. A fresh source per file
    // would give the same movement two identities and double everything.
    await importFile(LEDGER);
    const again = await importFile(LEDGER);

    expect(again.inserted).toBe(0);
    expect(again.updated).toBe(7);
    expect(await getSources()).toHaveLength(1);

    const events = await getAllEvents();
    expect(events).toHaveLength(7);
  });

  it('refuses a file it does not recognise, naming nothing it cannot read', async () => {
    await expect(importFile('alpha,beta\n1,2\n')).rejects.toBeInstanceOf(
      UnknownFileFormatError,
    );
    expect(await getSources()).toHaveLength(0);
  });

  it('leaves a file source out of syncing rather than erroring on it', async () => {
    // "Sync all" touches every source. A file source has nothing to poll,
    // and marking it `unknown module` would park a red diagnostic on it for
    // doing exactly what it is supposed to do.
    const { source } = await importFile(LEDGER);
    const report = await syncSource(source);
    expect(report.error).toBeUndefined();
    expect(report.inserted).toBe(0);

    const after = (await getSources()).find((row) => row.id === source.id);
    expect(after?.lastError).toBeUndefined();
    // And it did not delete what the import wrote.
    expect(await getAllEvents()).toHaveLength(7);
  });
});

describe('what Kraken calls "earn"', () => {
  /**
   * `earn` is two different things, and the parser read neither: it mapped
   * the type and never looked at `subtype`.
   *
   * Measured on a real 198-row export: 53 rows were `earn`/`reward`, which
   * is yield, and 8 were `earn`/`autoallocation`, which is Kraken moving a
   * dust balance between the user's own spot and earn wallets and back
   * again. The second kind was reported as income, and because no
   * jurisdiction can tell a staking reward from an airdrop without a
   * marker, it surfaced on the tax report as five events nobody could
   * classify - for an allocation that netted to exactly zero.
   */
  const header =
    '"txid","refid","time","type","subtype","aclass","asset","wallet","amount","fee","balance"';
  const row = (
    txid: string,
    refid: string,
    subtype: string,
    asset: string,
    wallet: string,
    amount: string,
  ) =>
    `"${txid}","${refid}","2025-10-01 13:43:14","earn","${subtype}","currency","${asset}","${wallet}","${amount}","0.0000","0.0000"`;

  it("treats an auto-allocation as one movement between the user's own wallets", async () => {
    // One refid, four rows: two assets leaving spot and arriving in earn.
    const csv = [
      header,
      row(
        'L1',
        'EL6KFZD-HSWBI-NAZYLK',
        'autoallocation',
        'ADA',
        'spot / main',
        '-0.00000068',
      ),
      row(
        'L2',
        'EL6KFZD-HSWBI-NAZYLK',
        'autoallocation',
        'ADA',
        'earn / liquid',
        '0.00000068',
      ),
      row(
        'L3',
        'EL6KFZD-HSWBI-NAZYLK',
        'autoallocation',
        'XETH',
        'spot / main',
        '-0.0000011600',
      ),
      row(
        'L4',
        'EL6KFZD-HSWBI-NAZYLK',
        'autoallocation',
        'XETH',
        'earn / liquid',
        '0.0000011600',
      ),
    ].join('\n');

    const { events } = krakenCsv.parse(csv);

    // One event, because `isInternalTransfer` nets per asset WITHIN an
    // event: four separate events each carry one leg, never net to zero,
    // and each outgoing one becomes a disposal of dust the user still
    // holds.
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('transfer');
    expect(events[0].legs).toHaveLength(4);
  });

  it('nets an auto-allocation to nothing once the ledger folds it', async () => {
    const csv = [
      header,
      row(
        'L1',
        'ELREF-1',
        'autoallocation',
        'ADA',
        'spot / main',
        '-0.00000068',
      ),
      row(
        'L2',
        'ELREF-1',
        'autoallocation',
        'ADA',
        'earn / liquid',
        '0.00000068',
      ),
    ].join('\n');

    const { events } = krakenCsv.parse(csv);
    const owned = new Set(['spot / main', 'earn / liquid']);
    const asLedger: LedgerEvent = {
      ...events[0],
      id: 'e1',
      sourceId: 's1',
    };

    const { isInternalTransfer } = await import('@/ledger/balances');
    expect(isInternalTransfer(asLedger, owned)).toBe(true);
  });

  it('keeps a genuine reward a reward, one per row', async () => {
    const csv = [
      header,
      row('L5', 'ELREF-2', 'reward', 'XETH', 'earn / liquid', '0.0000000003'),
      row('L6', 'ELREF-3', 'reward', 'XETH', 'earn / liquid', '0.0000000004'),
    ].join('\n');

    const { events } = krakenCsv.parse(csv);

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.kind)).toEqual(['reward', 'reward']);
  });
});

describe('the asset codes a real export actually uses', () => {
  /**
   * The map held four codes - XXBT, XETH, ADA, ZEUR - on the documented
   * reasoning that Kraken's legacy X/Z names are the real asset codes and
   * the bare ones are only altnames, verified against /0/public/Assets.
   *
   * That is true of the API and NOT of the ledger export. Measured on a
   * real 198-row export: 175 rows were skipped, among them 58 in ETH, 35
   * in EUR, 24 in BTC and 24 in EUR.HOLD, leaving 22 ADA rows as the only
   * thing that imported. A tax report built on it was missing that
   * account's entire euro and bitcoin history - every deposit, every
   * purchase, and eleven withdrawals that look like disposals when the
   * exchange side of them is absent.
   */
  it('recognises the plain codes the export writes', () => {
    expect(assetIdForCode('BTC')).toBe('bitcoin:native');
    expect(assetIdForCode('XBT')).toBe('bitcoin:native');
    expect(assetIdForCode('ETH')).toBe('eth:native');
    expect(assetIdForCode('EUR')).toBe('fiat:eur');
    // And the legacy ones keep working: one export can carry both.
    expect(assetIdForCode('XXBT')).toBe('bitcoin:native');
    expect(assetIdForCode('ZEUR')).toBe('fiat:eur');
  });

  it('does not let ETHW fall into ether', () => {
    // EthereumPoW is a different chain with a different price. An alias
    // added by prefix rather than by exact code would merge the two
    // positions silently, which is the failure this map's "guessing an id
    // merges two different positions into one" note is about.
    expect(assetIdForCode('ETHW')).toBeNull();
    expect(assetIdForCode('ETH2')).toBeNull();
  });

  it('reads a held balance as the same asset it holds', () => {
    // `.HOLD` names WHERE the money is, not what it is - the same rule
    // already applied to .S, .M, .B, .F and .P. Seventeen deposits and
    // seven purchases sat in EUR.HOLD in the measured export.
    expect(stripWalletSuffix('EUR.HOLD')).toBe('EUR');
    expect(assetIdForCode('EUR.HOLD')).toBe('fiat:eur');
  });

  it('imports a euro purchase that used to be dropped', () => {
    const csv = [
      '"txid","refid","time","type","subtype","aclass","asset","wallet","amount","fee","balance"',
      '"L1","R1","2025-01-15 10:00:00","deposit","","currency","EUR","spot / main","500.0000","0.0000","500.0000"',
      '"L2","R2","2025-01-16 11:00:00","trade","","currency","BTC","spot / main","0.00500000","0.0000","0.00500000"',
    ].join('\n');

    const { events, skipped } = krakenCsv.parse(csv);

    expect(skipped).toEqual([]);
    expect(events).toHaveLength(2);
    expect(events[0].legs[0].assetId).toBe('fiat:eur');
    expect(events[1].legs[0].assetId).toBe('bitcoin:native');
    // 0.005 BTC in satoshis, not 0.005 stored raw.
    expect(events[1].legs[0].amount).toBe('500000');
  });
});
