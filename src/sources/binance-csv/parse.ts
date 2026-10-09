import Big from 'big.js';
import { readCsv, type CsvRow } from '@/sources/csv/readCsv';
import { makeSkipLog, toBaseUnits } from '@/sources/csv/ledgerShape';
import { USDC_ASSET_ID, USDT_ASSET_ID } from '@/prices/scale';
import type { ParseResult } from '@/sources/csv/types';
import type { DerivedEvent } from '@/sources/types';
import type {
  DerivativeKind,
  EventKind,
  Leg,
  RewardKind,
} from '@/ledger/types';

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

export const BINANCE_ASSETS: Record<string, string> = {
  BTC: 'bitcoin:native',
  ETH: 'eth:native',
  ADA: 'cardano:lovelace',
  EUR: 'fiat:eur',
  USDT: USDT_ASSET_ID,
  USDC: USDC_ASSET_ID,
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
  'realized profit and loss': 'derivative',
  'insurance fund compensation': 'derivative',
  'funding fee': 'derivative',
  'transfer between main and futures wallet': 'transfer',
};

/** What each futures settlement operation is. A futures `commission` is
 *  handled apart, because the same operation name on Spot is a referral
 *  reward. */
const DERIVATIVE_KINDS: Record<string, DerivativeKind> = {
  'realized profit and loss': 'pnl',
  'insurance fund compensation': 'pnl',
  'funding fee': 'funding',
};

const WALLET_TRANSFER = 'transfer between main and futures wallet';

/** What each reward operation is. */
const REWARD_KINDS: Record<string, RewardKind> = {
  'staking rewards': 'staking',
  'simple earn flexible interest': 'lending',
  distribution: 'airdrop',
  commission: 'other',
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
  /** Wallet-transfer events still waiting for their other half. */
  const pending = new Map<string, DerivedEvent[]>();

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
    // A commission paid in a futures account is a trading cost, not a
    // referral reward: the same operation name means both on Binance.
    const isFuturesCommission =
      operation === 'commission' && /futures/i.test(account);
    const kind: EventKind | undefined = isFee
      ? 'trade'
      : isFuturesCommission
        ? 'derivative'
        : KINDS[operation];
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
        // A negative futures commission is a cost; a positive one is a
        // rebate, money received, so a principal inflow.
        role:
          isFee || (isFuturesCommission && moved.lt(0)) ? 'fee' : 'principal',
      },
    ];

    const derivative: DerivativeKind | undefined = isFuturesCommission
      ? 'commission'
      : DERIVATIVE_KINDS[operation];

    const event: DerivedEvent = {
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
      ...(kind === 'reward' ? { rewardKind: REWARD_KINDS[operation] } : {}),
      ...(kind === 'derivative' && derivative !== undefined
        ? { derivative: { kind: derivative, product: 'futures' as const } }
        : {}),
      note: `Binance ${operation}`,
    };
    events.push(event);

    // The spot and futures halves of one wallet transfer are two rows with
    // the same timestamp, coin and absolute amount and opposite signs.
    // Grouped into one event they net to zero between two owned venues, as
    // Kraken's spot-to-staking rows do; left apart, every futures top-up
    // would read as a disposal. A row that never finds its partner stays
    // the per-row event it already is.
    if (operation === WALLET_TRANSFER) {
      const key = `${at}|${coin.trim().toUpperCase()}|${moved.abs().toString()}`;
      const waiting = pending.get(key) ?? [];
      const partner = waiting.find(
        (candidate) => candidate.legs[0].direction !== legs[0].direction,
      );
      if (partner) {
        partner.legs.push(...legs);
        events.pop();
        waiting.splice(waiting.indexOf(partner), 1);
      } else {
        waiting.push(event);
        pending.set(key, waiting);
      }
    }
  });

  return { events, skipped: skipped.lines() };
};
