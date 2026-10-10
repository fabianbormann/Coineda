import Big from 'big.js';
import { readCsvRows } from '@/sources/csv/readCsv';
import { resolveTicker } from '@/sources/csv/resolveTicker';
import {
  makeSkipLog,
  stripThousands,
  toBaseUnits,
  UnscalableAmountError,
} from '@/sources/csv/ledgerShape';
import type { ParseResult } from '@/sources/csv/types';
import type { DerivedEvent } from '@/sources/types';
import type { EventKind, Leg, RewardKind } from '@/ledger/types';

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

export const coinbaseAssetId = (ticker: string): string | null =>
  resolveTicker(ticker);

/** Which way the asset moved, per Coinbase transaction type. `null` means
 *  recognised but not a movement of its own. */
const DIRECTIONS: Record<
  string,
  { kind: EventKind; incoming: boolean; rewardKind?: RewardKind }
> = {
  buy: { kind: 'trade', incoming: true },
  'advanced trade buy': { kind: 'trade', incoming: true },
  sell: { kind: 'trade', incoming: false },
  'advanced trade sell': { kind: 'trade', incoming: false },
  send: { kind: 'transfer', incoming: false },
  receive: { kind: 'transfer', incoming: true },
  deposit: { kind: 'fiat-in', incoming: true },
  withdrawal: { kind: 'fiat-out', incoming: false },
  'rewards income': { kind: 'reward', incoming: true, rewardKind: 'lending' },
  'staking income': { kind: 'reward', incoming: true, rewardKind: 'staking' },
  'inflation reward': { kind: 'reward', incoming: true, rewardKind: 'staking' },
  'learning reward': { kind: 'reward', incoming: true, rewardKind: 'airdrop' },
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

    const assetId = coinbaseAssetId(asset) ?? undefined;
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
      // Commas only as thousands groups; a decimal comma is refused.
      const plain = stripThousands(quantity);
      if (plain === undefined) {
        throw new Error(quantity);
      }
      moved = new Big(plain).abs();
    } catch {
      skipped.note('rows with an unreadable quantity');
      return;
    }
    if (moved.eq(0)) {
      return;
    }

    let amount: string;
    try {
      amount = toBaseUnits('coinbase-csv', moved.toString(), assetId);
    } catch (error) {
      if (error instanceof UnscalableAmountError) {
        skipped.note(`unparseable amounts in ${asset}`);
        return;
      }
      throw error;
    }

    // The money columns are validated BEFORE anything is emitted, so one
    // unreadable figure skips the whole row rather than booking a buy with
    // no cost. Currency symbols are dropped, then commas must be thousands
    // groups: "1.234,56" is refused, never stripped into a thousandfold sum.
    const currency =
      at(row, 'price currency') || at(row, 'spot price currency');
    const counterAsset = coinbaseAssetId(currency) ?? undefined;
    const fees = at(row, 'fees and/or spread') || at(row, 'fees');
    const money = (value: string): string | undefined => {
      if (value === '') {
        return '';
      }
      const plain = stripThousands(value.replace(/[^0-9.,-]/g, ''));
      return plain === undefined || !/^-?\d*\.?\d+$/.test(plain)
        ? undefined
        : plain;
    };
    const subtotal = money(at(row, 'subtotal'));
    const total = money(at(row, 'total (inclusive of fees and/or spread)'));
    const charged = money(fees);
    if (
      subtotal === undefined ||
      total === undefined ||
      charged === undefined
    ) {
      skipped.note(`unparseable amounts in ${asset}`);
      return;
    }

    const legs: Leg[] = [
      {
        assetId,
        amount,
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
    try {
      if (movement.kind === 'trade' && counterAsset && subtotal !== '') {
        const paid = new Big(subtotal);
        if (paid.gt(0)) {
          legs.push({
            assetId: counterAsset,
            amount: toBaseUnits('coinbase-csv', paid.toString(), counterAsset),
            direction: movement.incoming ? 'out' : 'in',
            venue: 'coinbase',
            role: 'principal',
          });
        }
      }
      if (charged !== '' && counterAsset) {
        const fee = new Big(charged);
        if (fee.gt(0)) {
          legs.push({
            assetId: counterAsset,
            amount: toBaseUnits('coinbase-csv', fee.toString(), counterAsset),
            direction: 'out',
            venue: 'coinbase',
            role: 'fee',
          });
        }
      }
    } catch (error) {
      if (error instanceof UnscalableAmountError) {
        skipped.note(`unparseable amounts in ${asset}`);
        return;
      }
      throw error;
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
      ...(movement.rewardKind ? { rewardKind: movement.rewardKind } : {}),
      note: `Coinbase ${type}`,
    });
  });

  return { events, skipped: skipped.lines() };
};
