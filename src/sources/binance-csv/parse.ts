import Big from 'big.js';
import { readCsv, type CsvRow } from '@/sources/csv/readCsv';
import { makeSkipLog, toBaseUnits } from '@/sources/csv/ledgerShape';
import type { ParseResult } from '@/sources/csv/types';
import type { DerivedEvent } from '@/sources/types';
import type { EventKind, Leg } from '@/ledger/types';

/**
 * Binance's "Transaction History" export.
 *
 * Shaped like Kraken's ledger and unlike Coinbase's: one row per ASSET
 * CHANGE, with a signed `Change` column, so a trade appears as two or three
 * rows sharing a timestamp and operation. They are emitted as separate
 * events rather than paired up, because pairing would be guessing - the
 * ledger folds the legs correctly either way, and one operation can produce
 * more than two rows.
 *
 * Binance uses plain tickers (BTC, ETH, ADA, EUR), with none of Kraken's X
 * and Z prefixes.
 *
 * NOT verified against a real export. The column set below is Binance's
 * documented one, and the parser requires it by name and reports what it
 * actually found when it differs - so the first run against a real file
 * produces a precise bug report rather than silent garbage. That is the
 * same stance the Bitpanda module shipped with, and the live run found two
 * real problems in an hour.
 */
const REQUIRED = ['utc_time', 'operation', 'coin', 'change'] as const;

const BINANCE_ASSETS: Record<string, string> = {
  BTC: 'bitcoin:native',
  ETH: 'eth:native',
  ADA: 'cardano:lovelace',
  EUR: 'fiat:eur',
};

/**
 * Binance operation names to event kinds.
 *
 * Deliberately a allow-list. Binance has well over a hundred operation
 * names across its products, and an operation absent from here is skipped
 * and reported rather than guessed at - guessing turns a margin interest
 * charge into a disposal.
 */
const KINDS: Record<string, EventKind> = {
  deposit: 'transfer',
  withdraw: 'transfer',
  'fiat deposit': 'fiat-in',
  'fiat withdraw': 'fiat-out',
  buy: 'trade',
  sell: 'trade',
  'transaction buy': 'trade',
  'transaction sold': 'trade',
  'transaction spend': 'trade',
  'transaction revenue': 'trade',
  'transaction related': 'trade',
  'staking rewards': 'reward',
  'simple earn flexible interest': 'reward',
  distribution: 'reward',
  commission: 'reward',
};

/** Fee rows are their own operation on Binance, and are charged as a fee
 *  leg rather than a disposal of their own. */
const FEE_OPERATIONS = new Set(['fee', 'transaction fee', 'trading fee']);

const cell = (row: CsvRow, column: string): string => {
  const key = Object.keys(row).find(
    (name) =>
      name
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '_') === column,
  );
  return key === undefined ? '' : row[key].trim();
};

export const hasBinanceHeader = (header: string[]): boolean => {
  const names = new Set(
    header.map((name) =>
      name
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '_'),
    ),
  );
  return REQUIRED.every((column) => names.has(column));
};

export const sniff = (text: string): boolean => {
  try {
    return hasBinanceHeader(readCsv(text).header);
  } catch {
    return false;
  }
};

/**
 * Binance writes `2024-03-10 14:22:51`, UTC with no zone marker - the
 * column is even called UTC_Time. Read as UTC explicitly: `Date.parse` on a
 * space-separated zoneless string is implementation-defined and in practice
 * reads LOCAL time, moving every row by the machine's offset and, at a year
 * boundary, into a different tax year.
 */
export const parseBinanceTime = (value: string): number => {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(
    value.trim(),
  );
  if (match === null) {
    return Number.NaN;
  }
  const [, y, m, d, hh, mm, ss] = match;
  return Date.UTC(
    Number(y),
    Number(m) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    Number(ss),
  );
};

export const parse = (input: string): ParseResult => {
  const { header, rows } = readCsv(input);
  if (!hasBinanceHeader(header)) {
    throw new Error(
      `binance-csv: this does not look like a Binance transaction export. It needs the columns ${REQUIRED.join(
        ', ',
      )}, and the file carried: ${header.join(', ') || '(no header)'}`,
    );
  }

  const events: DerivedEvent[] = [];
  const skipped = makeSkipLog();

  rows.forEach((row, index) => {
    const operation = cell(row, 'operation').toLowerCase();
    const coin = cell(row, 'coin');
    const change = cell(row, 'change');
    const account = cell(row, 'account') || 'binance';

    if (operation === '') {
      skipped.note('a row with no operation');
      return;
    }

    const isFee = FEE_OPERATIONS.has(operation);
    const kind = isFee ? 'trade' : KINDS[operation];
    if (kind === undefined) {
      skipped.note(`rows of operation "${operation}"`);
      return;
    }

    const assetId = BINANCE_ASSETS[coin.trim().toUpperCase()];
    if (assetId === undefined) {
      skipped.note(`holdings in ${coin || '(no coin)'}`);
      return;
    }

    const at = parseBinanceTime(cell(row, 'utc_time'));
    if (!Number.isFinite(at)) {
      skipped.note('rows with an unreadable time');
      return;
    }

    let moved: Big;
    try {
      moved = new Big(change === '' ? '0' : change.replace(/,/g, ''));
    } catch {
      skipped.note('rows with an unreadable change');
      return;
    }
    if (moved.eq(0)) {
      return;
    }

    const legs: Leg[] = [
      {
        assetId,
        amount: toBaseUnits('binance-csv', moved.abs().toString(), assetId),
        // Binance signs the change: negative leaves the account.
        direction: moved.lt(0) ? 'out' : 'in',
        venue: account,
        // A fee operation is a fee, not a principal movement. Folded the
        // same either way, but a jurisdiction's internal-transfer test
        // deliberately ignores fee legs, so mislabelling one turns a
        // transfer into a disposal.
        role: isFee ? 'fee' : 'principal',
      },
    ];

    events.push({
      // Binance gives no row id. The timestamp alone collides across the
      // legs of one trade, so the row's position carries the identity -
      // which makes a re-import of the SAME export converge, and a re-export
      // with rows inserted earlier shift. That is the honest limit of a
      // format with no ids in it, and it is why `updated` can read 0 on a
      // re-import where Kraken's would not.
      externalId: `${at}#${index}#${coin}`,
      timestamp: at,
      kind,
      origin: 'derived',
      legs,
      note: `Binance ${operation}`,
    });
  });

  return { events, skipped: skipped.lines() };
};
