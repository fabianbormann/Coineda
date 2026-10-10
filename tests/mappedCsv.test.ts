import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import mappedCsv from '@/sources/mapped-csv';
import {
  MappingRequiredError,
  type CsvMapping,
} from '@/sources/mapped-csv/types';
import {
  MappingColumnError,
  parseMapped,
  previewMapped,
  validateMapping,
} from '@/sources/mapped-csv/parse';
import { importMappedFile } from '@/sources/mapped-csv/importMapped';
import { detectFileModule } from '@/sources/csv/registry';
import {
  getAllEvents,
  getEventsBySource,
  getSources,
  openLedger,
  replaceSourceEvents,
} from '@/ledger/db';
import type { LedgerEvent } from '@/ledger/types';

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
  counter: { kind: 'fiat', currency: 'EUR' },
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
  counter: { kind: 'column' },
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

  it('books fiat-in and a reward, never guessing its kind from the label', () => {
    expect(dep.kind).toBe('fiat-in');
    expect(dep.legs[0]).toMatchObject({
      assetId: 'fiat:eur',
      amount: '1000',
      direction: 'in',
    });
    expect(reward.kind).toBe('reward');
    expect(reward.rewardKind).toBe('other');
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
    const first = await importMappedFile(A, mappingA, 'a.csv', { now: 1 });
    expect(first.inserted).toBe(4);
    expect(first.source.moduleId).toBe('mapped-csv');
    expect(first.source.label).toBe('Bison');
    expect(first.source.config).toEqual({
      mapping: JSON.stringify(mappingA),
      fileName: 'a.csv',
    });
    const second = await importMappedFile(A, mappingA, 'a.csv', { now: 2 });
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(4);
    expect(second.source.id).toBe(first.source.id);

    const other = await importMappedFile(
      A,
      { ...mappingA, venueLabel: 'Bitvavo' },
      'a.csv',
      { now: 3 },
    );
    expect(other.source.id).not.toBe(first.source.id);
    expect(await getSources()).toHaveLength(2);
    expect(await getAllEvents()).toHaveLength(8);
  });
});

describe('fix round 1', () => {
  const columnsOf = (patch: Partial<CsvMapping['columns']>): CsvMapping => ({
    ...mappingA,
    columns: { ...mappingA.columns, ...patch },
  });

  it('names mapped columns the header lacks', () => {
    const header = ['Datum', 'Typ', 'Coin', 'Menge', 'Gebühr', 'Preis'];
    expect(validateMapping(mappingA, header)).toEqual([]);
    expect(validateMapping(columnsOf({ price: 'Kurs' }), header)).toContain(
      'Column Kurs is not in the file',
    );
  });

  it('refuses to parse a file missing a mapped column', () => {
    expect(() => parseMapped(A, columnsOf({ fee: 'Gebuehr' }))).toThrow(
      MappingColumnError,
    );
    expect(() => parseMapped(A, columnsOf({ fee: 'Gebuehr' }))).toThrow(
      /Gebuehr/,
    );
  });

  it('books the fee in the counter asset of a fiat trade', () => {
    const withUsd = parseMapped(
      'time,sym,qty,px,fee,cc\n2024-05-01T10:00:00Z,BTC,0.5,100,1,USD\n',
      {
        ...mappingB,
        columns: {
          date: 'time',
          asset: 'sym',
          amount: 'qty',
          price: 'px',
          fee: 'fee',
          counterAsset: 'cc',
        },
        kinds: { '*': 'trade' },
        counter: { kind: 'fiat', currency: 'EUR' },
      },
    );
    expect(withUsd.events[0].legs.map((l) => [l.assetId, l.role])).toEqual([
      ['bitcoin:native', 'principal'],
      ['fiat:usd', 'principal'],
      ['fiat:usd', 'fee'],
    ]);
  });

  it('warns when a sign mapping only ever goes one way', () => {
    const csv = 'time,symbol,qty\n2024-05-02T10:00:00Z,BTC,0.1\n';
    const sign: CsvMapping = {
      ...mappingB,
      columns: { date: 'time', asset: 'symbol', amount: 'qty' },
    };
    expect(parseMapped(csv, sign).warnings).toEqual([
      'No outgoing rows: check the direction setting',
    ]);
    expect(previewMapped(csv.replace('0.1', '-0.1'), sign).warnings).toEqual([
      'No incoming rows: check the direction setting',
    ]);
    expect(parseMapped(B, mappingB).warnings).toEqual([]);
  });

  it('skips a zero price', () => {
    const csv =
      'Datum;Typ;Coin;Menge;Preis\n07.03.2024 10:00:00;Kauf;BTC;0,5;0,00\n';
    const r = parseMapped(csv, {
      ...mappingA,
      columns: {
        date: 'Datum',
        type: 'Typ',
        asset: 'Coin',
        amount: 'Menge',
        price: 'Preis',
      },
    });
    expect(r.events).toHaveLength(0);
    expect(r.skipped.join('\n')).toMatch(/unparseable amounts/);
  });
});

describe('a second file from the same venue', () => {
  // A later export of the same venue: a type value is missing and the order
  // of first appearance differs, so the dialog's mapping is not identical.
  const A2 = `Datum;Typ;Coin;Menge;Gebühr;Preis
05.01.2025 10:00:00;Verkauf;BTC;0,1;;50000,00
06.01.2025 10:00:00;Kauf;ETH;1,0;;3000,00
`;
  const mappingA2: CsvMapping = {
    ...mappingA,
    direction: { mode: 'type', in: ['Kauf'], out: ['Verkauf'] },
    kinds: { Verkauf: 'trade', Kauf: 'trade' },
  };

  beforeEach(async () => {
    const db = await openLedger();
    for (const store of ['events', 'sources', 'cursors'] as const) {
      await db.clear(store);
    }
  });

  it('keeps the earlier file’s events when not asked to replace them', async () => {
    const first = await importMappedFile(A, mappingA, 'a.csv', { now: 1 });
    const second = await importMappedFile(A2, mappingA2, 'a2.csv', { now: 2 });
    expect(second.source.id).toBe(first.source.id);
    expect(second.superseded).toBe(0);
    expect(second.inserted).toBe(2);
    expect(await getAllEvents()).toHaveLength(6);
  });

  it('replaces only this venue’s events when asked, and saves the mapping', async () => {
    const first = await importMappedFile(A, mappingA, 'a.csv', { now: 1 });
    const other = await importMappedFile(
      A,
      { ...mappingA, venueLabel: 'Bitvavo' },
      'a.csv',
      { now: 1 },
    );
    const second = await importMappedFile(A2, mappingA2, 'a2.csv', {
      now: 2,
      replaceExisting: true,
    });
    expect(second.source.id).toBe(first.source.id);
    expect(second.superseded).toBe(4);
    expect(second.inserted).toBe(2);
    const bison = await getEventsBySource(first.source.id);
    expect(bison.map((e) => e.externalId).sort()).toEqual(
      parseMapped(A2, mappingA2)
        .events.map((e) => e.externalId)
        .sort(),
    );
    expect(await getEventsBySource(other.source.id)).toHaveLength(4);
    const saved = (await getSources()).find((s) => s.id === first.source.id)!;
    expect(saved.config.mapping).toBe(JSON.stringify(mappingA2));
    expect(saved.config.fileName).toBe('a2.csv');
  });

  it('replaceSourceEvents leaves the old events untouched when a write fails', async () => {
    const first = await importMappedFile(A, mappingA, 'a.csv', { now: 1 });
    const before = await getEventsBySource(first.source.id);
    const good: LedgerEvent = { ...before[0], id: 'new-1', externalId: 'n1' };
    // A function cannot be stored: the put throws inside the transaction,
    // after the deletes were issued.
    const bad = {
      ...before[1],
      id: 'new-2',
      externalId: 'n2',
      poison: () => 1,
    } as unknown as LedgerEvent;
    await expect(
      replaceSourceEvents(first.source.id, [good, bad]),
    ).rejects.toThrow();
    const after = await getEventsBySource(first.source.id);
    expect(after.map((e) => e.id).sort()).toEqual(
      before.map((e) => e.id).sort(),
    );
  });

  it('replaceSourceEvents refuses rows of another source', async () => {
    const first = await importMappedFile(A, mappingA, 'a.csv', { now: 1 });
    const [row] = await getEventsBySource(first.source.id);
    await expect(
      replaceSourceEvents(first.source.id, [
        { ...row, id: 'x', sourceId: 'someone-else' },
      ]),
    ).rejects.toThrow();
    expect(await getEventsBySource(first.source.id)).toHaveLength(4);
  });
});

describe('fix wave', () => {
  const plain: CsvMapping = {
    ...mappingB,
    columns: { date: 'time', asset: 'symbol', amount: 'qty' },
  };

  describe('dot-mode fiat follows the thousands-group rule', () => {
    const fiatIn = (qty: string) =>
      parseMapped(`time,symbol,qty\n2024-05-02T10:00:00Z,EUR,"${qty}"\n`, {
        ...plain,
        kinds: { '*': 'fiat-in' },
      });

    it('reads a grouped amount', () => {
      const r = fiatIn('4,500.50');
      expect(r.events).toHaveLength(1);
      expect(r.events[0].legs[0]).toMatchObject({
        assetId: 'fiat:eur',
        amount: '4500.5',
      });
    });

    it.each(['0,5', '4500,50'])('skips %s as unparseable', (qty) => {
      const r = fiatIn(qty);
      expect(r.events).toHaveLength(0);
      expect(r.skipped.join('\n')).toMatch(/unparseable amounts/);
    });

    it('applies the rule to a fiat counter amount too', () => {
      const r = parseMapped(
        'time,symbol,qty,cc,ca\n2024-05-02T10:00:00Z,BTC,0.1,EUR,"0,5"\n',
        {
          ...plain,
          columns: {
            ...plain.columns,
            counterAsset: 'cc',
            counterAmount: 'ca',
          },
          kinds: { '*': 'trade' },
        },
      );
      expect(r.events).toHaveLength(0);
      expect(r.skipped.join('\n')).toMatch(/unparseable amounts/);
    });
  });

  it('books a fee row inside a trade-id group as a fee leg', () => {
    const csv = `time,type,trade_id,symbol,qty
2024-05-01T10:00:00Z,Buy,T9,BTC,0.01
2024-05-01T10:00:00Z,Buy,T9,EUR,-400
2024-05-01T10:00:00Z,Fee,T9,EUR,-1
`;
    const r = parseMapped(csv, {
      ...mappingB,
      columns: {
        date: 'time',
        type: 'type',
        tradeId: 'trade_id',
        asset: 'symbol',
        amount: 'qty',
      },
      kinds: { Buy: 'trade', Fee: 'fee' },
    });
    expect(r.events).toHaveLength(1);
    expect(r.events[0].kind).toBe('trade');
    expect(shape(r.events[0].legs)).toEqual([
      ['bitcoin:native', '1000000', 'in', 'principal'],
      ['fiat:eur', '400', 'out', 'principal'],
      ['fiat:eur', '1', 'out', 'fee'],
    ]);
  });

  describe('the fiat counter currency is explicit', () => {
    const priced = (counter: CsvMapping['counter']) =>
      parseMapped('time,sym,qty,px\n2024-05-01T10:00:00Z,BTC,0.5,100\n', {
        ...plain,
        columns: { date: 'time', asset: 'sym', amount: 'qty', price: 'px' },
        kinds: { '*': 'trade' },
        counter,
      });

    it('books the price in the named currency', () => {
      const r = priced({ kind: 'fiat', currency: 'USD' });
      expect(shape(r.events[0].legs)).toEqual([
        ['bitcoin:native', '50000000', 'in', 'principal'],
        ['fiat:usd', '50', 'out', 'principal'],
      ]);
    });

    it('skips a price with no counter column and no fiat named', () => {
      const r = priced({ kind: 'column' });
      expect(r.events).toHaveLength(0);
      expect(r.skipped.join('\n')).toMatch(/no counter asset/);
    });

    it('asks for a known fiat currency', () => {
      const key = 'Choose the fiat currency of the price column';
      expect(
        validateMapping({
          ...mappingA,
          counter: { kind: 'fiat', currency: '' },
        }),
      ).toContain(key);
      expect(
        validateMapping({
          ...mappingA,
          counter: { kind: 'fiat', currency: 'BTC' },
        }),
      ).toContain(key);
      expect(validateMapping(mappingA)).not.toContain(key);
    });
  });

  const countered = (qty: string, amount: string) =>
    parseMapped(
      `time,symbol,qty,cc,ca\n2024-05-02T10:00:00Z,BTC,${qty},EUR,${amount}\n`,
      {
        ...plain,
        columns: {
          ...plain.columns,
          counterAsset: 'cc',
          counterAmount: 'ca',
        },
        kinds: { '*': 'trade' },
      },
    );

  it.each(['0', '0.00', '-0'])(
    'skips a row whose counter amount is %s',
    (amount) => {
      const r = countered('0.1', amount);
      expect(r.events).toHaveLength(0);
      expect(r.skipped.join('\n')).toMatch(/unparseable amounts/);
    },
  );

  it('takes a signed counter amount by magnitude, opposite the principal', () => {
    expect(shape(countered('0.1', '-4500').events[0].legs)).toEqual([
      ['bitcoin:native', '10000000', 'in', 'principal'],
      ['fiat:eur', '4500', 'out', 'principal'],
    ]);
    expect(shape(countered('-0.1', '+4500').events[0].legs)).toEqual([
      ['bitcoin:native', '10000000', 'out', 'principal'],
      ['fiat:eur', '4500', 'in', 'principal'],
    ]);
  });

  it('skips a row whose price times amount rounds to no fiat at all', () => {
    const r = parseMapped(
      'time,sym,qty,px\n2024-05-01T10:00:00Z,BTC,0.00000001,0.1\n',
      {
        ...plain,
        columns: { date: 'time', asset: 'sym', amount: 'qty', price: 'px' },
        kinds: { '*': 'trade' },
        counter: { kind: 'fiat', currency: 'EUR' },
      },
    );
    expect(r.events).toHaveLength(0);
    expect(r.skipped.join('\n')).toMatch(/unparseable amounts/);
  });
});
