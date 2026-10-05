import Big from 'big.js';
import { readCsvRows } from '@/sources/csv/readCsv';
import { makeSkipLog, toBaseUnits } from '@/sources/csv/ledgerShape';
import type { ParseResult } from '@/sources/csv/types';
import type { DerivedEvent } from '@/sources/types';
import type { EventKind, Leg } from '@/ledger/types';

/**
 * Coinbase's "Transaction history" export.
 *
 * Differs from Kraken's and Binance's in two ways that both matter:
 *
 * - **A preamble.** The file opens with several lines of account blurb
 *   before the real header, so the header is FOUND rather than assumed to
 *   be row one. Reading row one as the header produces a table whose every
 *   column is named after a sentence.
 * - **Unsigned quantities.** `Quantity Transacted` is always positive and
 *   the direction lives in `Transaction Type`. A parser that trusted a sign
 *   here would book every sale as a purchase.
 *
 * One row is one movement, with the counter-currency given as a total
 * rather than as its own row - so a Buy emits TWO legs from one row, which
 * is the opposite of the Kraken and Binance shape.
 *
 * NOT verified against a real export. The columns below are Coinbase's
 * documented ones; the parser requires them by name and reports what it
 * actually found when they differ, so a first run against a real file
 * produces a precise bug report rather than silent garbage.
 */
const REQUIRED = ['transaction type', 'asset', 'quantity transacted'] as const;

const COINBASE_ASSETS: Record<string, string> = {
  BTC: 'bitcoin:native',
  ETH: 'eth:native',
  ADA: 'cardano:lovelace',
  EUR: 'fiat:eur',
};

/** Which way the asset moved, per Coinbase transaction type. `null` means
 *  recognised but not a movement of its own. */
const DIRECTIONS: Record<string, { kind: EventKind; incoming: boolean }> = {
  buy: { kind: 'trade', incoming: true },
  'advanced trade buy': { kind: 'trade', incoming: true },
  sell: { kind: 'trade', incoming: false },
  'advanced trade sell': { kind: 'trade', incoming: false },
  send: { kind: 'transfer', incoming: false },
  receive: { kind: 'transfer', incoming: true },
  deposit: { kind: 'fiat-in', incoming: true },
  withdrawal: { kind: 'fiat-out', incoming: false },
  'rewards income': { kind: 'reward', incoming: true },
  'staking income': { kind: 'reward', incoming: true },
  'inflation reward': { kind: 'reward', incoming: true },
  'learning reward': { kind: 'reward', incoming: true },
};

const norm = (name: string): string => name.trim().toLowerCase();

/**
 * Finds the real header row, past Coinbase's preamble.
 *
 * Matched on the columns it must contain rather than on a row number: the
 * preamble's length is not a promise anybody made, and counting lines
 * breaks the first time Coinbase adds one.
 */
export const findHeaderRow = (rows: string[][]): number =>
  rows.findIndex((row) => {
    const names = new Set(row.map(norm));
    return REQUIRED.every((column) => names.has(column));
  });

export const sniff = (text: string): boolean => {
  try {
    return findHeaderRow(readCsvRows(text)) !== -1;
  } catch {
    return false;
  }
};

/** Coinbase writes an ISO instant with a zone - `2024-03-10T14:22:51Z` -
 *  so unlike Kraken and Binance this one is safe to hand to Date.parse. */
export const parseCoinbaseTime = (value: string): number =>
  Date.parse(value.trim());

export const parse = (input: string): ParseResult => {
  const rows = readCsvRows(input);
  const headerAt = findHeaderRow(rows);
  if (headerAt === -1) {
    const seen = rows[0]?.join(', ') ?? '(empty file)';
    throw new Error(
      `coinbase-csv: this does not look like a Coinbase transaction export. It needs the columns ${REQUIRED.join(
        ', ',
      )} somewhere in the file, and the first line carried: ${seen}`,
    );
  }

  const header = rows[headerAt].map(norm);
  const at = (row: string[], column: string): string => {
    const index = header.indexOf(column);
    return index === -1 ? '' : (row[index] ?? '').trim();
  };

  const events: DerivedEvent[] = [];
  const skipped = makeSkipLog();

  rows.slice(headerAt + 1).forEach((row, index) => {
    const type = at(row, 'transaction type').toLowerCase();
    const asset = at(row, 'asset');
    const quantity = at(row, 'quantity transacted');

    if (type === '') {
      skipped.note('a row with no transaction type');
      return;
    }
    const movement = DIRECTIONS[type];
    if (movement === undefined) {
      skipped.note(`rows of type "${type}"`);
      return;
    }

    const assetId = COINBASE_ASSETS[asset.trim().toUpperCase()];
    if (assetId === undefined) {
      skipped.note(`holdings in ${asset || '(no asset)'}`);
      return;
    }

    const when = parseCoinbaseTime(at(row, 'timestamp'));
    if (!Number.isFinite(when)) {
      skipped.note('rows with an unreadable timestamp');
      return;
    }

    let moved: Big;
    try {
      // Always positive in this format: the direction is the type's, not
      // the number's. Taking abs() rather than trusting a sign that is not
      // there keeps a stray minus from flipping a sale into a purchase.
      moved = new Big(quantity.replace(/,/g, '')).abs();
    } catch {
      skipped.note('rows with an unreadable quantity');
      return;
    }
    if (moved.eq(0)) {
      return;
    }

    const legs: Leg[] = [
      {
        assetId,
        amount: toBaseUnits('coinbase-csv', moved.toString(), assetId),
        direction: movement.incoming ? 'in' : 'out',
        venue: 'coinbase',
        role: 'principal',
      },
    ];

    // The counter-currency, given on the SAME row as a total rather than as
    // its own row. Without it a buy records crypto arriving from nowhere,
    // and the tax engine has no cost basis to match a later disposal
    // against. The subtotal excludes fees and is the amount that actually
    // bought the asset; `Total` includes them.
    const currency =
      at(row, 'price currency') || at(row, 'spot price currency');
    const subtotal = at(row, 'subtotal');
    const counterAsset = COINBASE_ASSETS[currency.trim().toUpperCase()];
    if (movement.kind === 'trade' && counterAsset && subtotal !== '') {
      try {
        const paid = new Big(subtotal.replace(/[^0-9.-]/g, ''));
        if (paid.gt(0)) {
          legs.push({
            assetId: counterAsset,
            amount: toBaseUnits('coinbase-csv', paid.toString(), counterAsset),
            direction: movement.incoming ? 'out' : 'in',
            venue: 'coinbase',
            role: 'principal',
          });
        }
      } catch {
        skipped.note('rows with an unreadable subtotal');
      }
    }

    const fees = at(row, 'fees and/or spread') || at(row, 'fees');
    if (fees !== '' && counterAsset) {
      try {
        const charged = new Big(fees.replace(/[^0-9.-]/g, ''));
        if (charged.gt(0)) {
          legs.push({
            assetId: counterAsset,
            amount: toBaseUnits(
              'coinbase-csv',
              charged.toString(),
              counterAsset,
            ),
            direction: 'out',
            venue: 'coinbase',
            role: 'fee',
          });
        }
      } catch {
        skipped.note('rows with an unreadable fee');
      }
    }

    const id = at(row, 'id');
    events.push({
      // Coinbase's own ID where the export carries one; otherwise the
      // row's position, which makes a re-import of the SAME export converge
      // and is the honest limit of a format without ids.
      externalId: id !== '' ? id : `${when}#${index}#${asset}`,
      timestamp: when,
      kind: movement.kind,
      origin: 'derived',
      legs,
      note: `Coinbase ${type}`,
    });
  });

  return { events, skipped: skipped.lines() };
};
