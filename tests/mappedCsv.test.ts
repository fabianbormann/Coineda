import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import mappedCsv from '@/sources/mapped-csv';
import {
  MappingRequiredError,
  type CsvMapping,
} from '@/sources/mapped-csv/types';
import {
  parseMapped,
  previewMapped,
  validateMapping,
} from '@/sources/mapped-csv/parse';
import { importMappedFile } from '@/sources/mapped-csv/importMapped';
import { detectFileModule } from '@/sources/csv/registry';
import { getAllEvents, getSources, openLedger } from '@/ledger/db';

const A = `Datum;Typ;Coin;Menge;Gebühr;Preis
07.03.2024 10:00:00;Kauf;BTC;0,5;2,50;40000,00
08.03.2024 11:00:00;Verkauf;BTC;0,2;1,00;42000,00
09.03.2024 12:00:00;Einzahlung;EUR;1000,00;;
10.03.2024 13:00:00;Staking;ADA;12,3;;
11.03.2024 14:00:00;Kauf;XYZ;1,0;;10,00
12.03.2024 15:00:00;Bonus;BTC;0,001;;
`;

const B = `time,trade_id,symbol,qty,fee,fee_ccy,txid
2024-05-01T10:00:00Z,T1,ETH,1.5,,,
2024-05-01T10:00:00Z,T1,EUR,-4500,4.5,EUR,
2024-05-02T10:00:00Z,,BTC,-0.1,,,abc123
`;

const mappingA: CsvMapping = {
  version: 1,
  venueLabel: 'Bison',
  delimiter: ';',
  columns: {
    date: 'Datum',
    type: 'Typ',
    asset: 'Coin',
    amount: 'Menge',
    fee: 'Gebühr',
    price: 'Preis',
  },
  dateFormat: 'dmy',
  timeZone: 'Europe/Berlin',
  decimal: 'comma',
  direction: {
    mode: 'type',
    in: ['Kauf', 'Einzahlung', 'Staking'],
    out: ['Verkauf'],
  },
  kinds: {
    Kauf: 'trade',
    Verkauf: 'trade',
    Einzahlung: 'fiat-in',
    Staking: 'reward',
  },
  fiatCounter: true,
};

const mappingB: CsvMapping = {
  version: 1,
  venueLabel: 'Sign',
  delimiter: ',',
  columns: {
    date: 'time',
    asset: 'symbol',
    amount: 'qty',
    fee: 'fee',
    feeAsset: 'fee_ccy',
    tradeId: 'trade_id',
    txHash: 'txid',
  },
  dateFormat: 'iso',
  timeZone: 'UTC',
  decimal: 'dot',
  direction: { mode: 'sign' },
  kinds: { '*': 'transfer' },
  fiatCounter: false,
};

const shape = (
  legs: { assetId: string; amount: string; direction: string; role: string }[],
) => legs.map((l) => [l.assetId, l.amount, l.direction, l.role]);

describe('parseMapped, type-tagged decimal-comma file', () => {
  const result = parseMapped(A, mappingA);
  const [t1, t2, dep, reward] = result.events;

  it('emits four events with Berlin-winter timestamps', () => {
    expect(result.events).toHaveLength(4);
    expect(
      result.events.map((e) => new Date(e.timestamp).toISOString()),
    ).toEqual([
      '2024-03-07T09:00:00.000Z',
      '2024-03-08T10:00:00.000Z',
      '2024-03-09T11:00:00.000Z',
      '2024-03-10T12:00:00.000Z',
    ]);
  });

  it('books a buy as principal in, fiat counter out, fee out', () => {
    expect(t1.kind).toBe('trade');
    expect(shape(t1.legs)).toEqual([
      ['bitcoin:native', '50000000', 'in', 'principal'],
      ['fiat:eur', '20000', 'out', 'principal'],
      ['fiat:eur', '2.5', 'out', 'fee'],
    ]);
    expect(t1.legs.every((l) => l.venue === 'csv:Bison')).toBe(true);
    expect(t1.note).toBe('Bison · Kauf');
    expect(t1.origin).toBe('derived');
  });

  it('books a sell the other way round', () => {
    expect(shape(t2.legs)).toEqual([
      ['bitcoin:native', '20000000', 'out', 'principal'],
      ['fiat:eur', '8400', 'in', 'principal'],
      ['fiat:eur', '1', 'out', 'fee'],
    ]);
  });

  it('books fiat-in and a staking reward', () => {
    expect(dep.kind).toBe('fiat-in');
    expect(dep.legs[0]).toMatchObject({
      assetId: 'fiat:eur',
      amount: '1000',
      direction: 'in',
    });
    expect(reward.kind).toBe('reward');
    expect(reward.rewardKind).toBe('staking');
    expect(reward.legs[0]).toMatchObject({
      amount: '12300000',
      direction: 'in',
    });
  });

  it('reports what it left out and why', () => {
    expect(result.unresolved).toEqual(['XYZ']);
    expect(result.skipped.join('\n')).toMatch(/holdings in XYZ/);
    expect(result.skipped.join('\n')).toMatch(/rows of type "Bonus"/);
  });
});

describe('parseMapped, sign-based file with a trade id', () => {
  const { events } = parseMapped(B, mappingB);

  it('groups the rows sharing a trade id into one trade', () => {
    expect(events).toHaveLength(2);
    const trade = events.find((e) => e.kind === 'trade')!;
    expect(shape(trade.legs)).toEqual([
      ['eth:native', '1500000000000000000', 'in', 'principal'],
      ['fiat:eur', '4500', 'out', 'principal'],
      ['fiat:eur', '4.5', 'out', 'fee'],
    ]);
  });

  it('books a lone row as a transfer carrying its hash', () => {
    const transfer = events.find((e) => e.kind === 'transfer')!;
    expect(transfer.txHash).toBe('abc123');
    expect(transfer.legs).toHaveLength(1);
    expect(transfer.legs[0]).toMatchObject({
      amount: '10000000',
      direction: 'out',
    });
  });

  it('is deterministic, and gives a duplicated row a distinct id', () => {
    const again = parseMapped(B, mappingB).events;
    expect(again.map((e) => e.externalId)).toEqual(
      events.map((e) => e.externalId),
    );
    const dup = `${B}2024-05-02T10:00:00Z,,BTC,-0.1,,,abc123\n`;
    const ids = parseMapped(dup, mappingB).events.map((e) => e.externalId);
    expect(new Set(ids).size).toBe(3);
  });

  it('splits a trade id that spans more than a day', () => {
    const far = `${B}2024-05-09T10:00:00Z,T1,SOL,1,,,\n`;
    const r = parseMapped(far, mappingB);
    expect(r.skipped.join('\n')).toMatch(
      /trade groups spanning more than a day/,
    );
  });
});

describe('amount handling', () => {
  it('skips a row whose amount is not in the stated decimal style', () => {
    const r = parseMapped('time,symbol,qty\n2024-05-02T10:00:00Z,BTC,"0,1"\n', {
      ...mappingB,
      columns: { date: 'time', asset: 'symbol', amount: 'qty' },
    });
    expect(r.events).toHaveLength(0);
    expect(r.skipped.join('\n')).toMatch(/unparseable amounts/);
  });
});

describe('validateMapping', () => {
  it('accepts a sound mapping', () => {
    expect(validateMapping(mappingA)).toEqual([]);
    expect(validateMapping(mappingB)).toEqual([]);
  });
  it('asks for the date, asset and amount columns', () => {
    expect(
      validateMapping({
        ...mappingA,
        columns: { ...mappingA.columns, date: '' },
      }),
    ).toContain('Map the date, asset and amount columns');
  });
  it('refuses a type value that is both incoming and outgoing', () => {
    expect(
      validateMapping({
        ...mappingA,
        direction: { mode: 'type', in: ['Kauf'], out: ['Kauf'] },
      }),
    ).toContain('A type value cannot be both incoming and outgoing');
  });
  it('needs a type column for direction by type', () => {
    const columns = { ...mappingA.columns };
    delete columns.type;
    expect(validateMapping({ ...mappingA, columns })).toContain(
      'Direction by type needs a type column',
    );
  });
});

describe('previewMapped', () => {
  it('counts by kind and carries a sample', () => {
    const p = previewMapped(A, mappingA);
    expect(p.byKind.trade).toBe(2);
    expect(p.byKind.reward).toBe(1);
    expect(p.unresolved).toEqual(['XYZ']);
    expect(p.sample).toHaveLength(4);
  });
});

describe('mapped-csv module and import', () => {
  beforeEach(async () => {
    const db = await openLedger();
    for (const store of ['events', 'sources', 'cursors'] as const) {
      await db.clear(store);
    }
  });

  it('is never detected and cannot parse without a mapping', () => {
    expect(detectFileModule(A)).toBeNull();
    expect(mappedCsv.sniff(A)).toBe(false);
    expect(() => mappedCsv.parse('x')).toThrow(MappingRequiredError);
  });

  it('keeps one source per label and converges on re-import', async () => {
    const first = await importMappedFile(A, mappingA, 'a.csv', 1);
    expect(first.inserted).toBe(4);
    expect(first.source.moduleId).toBe('mapped-csv');
    expect(first.source.label).toBe('Bison');
    expect(first.source.config).toEqual({
      mapping: JSON.stringify(mappingA),
      fileName: 'a.csv',
    });
    const second = await importMappedFile(A, mappingA, 'a.csv', 2);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(4);
    expect(second.source.id).toBe(first.source.id);

    const other = await importMappedFile(
      A,
      { ...mappingA, venueLabel: 'Bitvavo' },
      'a.csv',
      3,
    );
    expect(other.source.id).not.toBe(first.source.id);
    expect(await getSources()).toHaveLength(2);
    expect(await getAllEvents()).toHaveLength(8);
  });
});
