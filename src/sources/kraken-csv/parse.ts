import Big from 'big.js';
import { readCsv, type CsvRow } from '@/sources/csv/readCsv';
import type { ParseResult } from '@/sources/csv/types';
import type { DerivedEvent } from '@/sources/types';
import type { EventKind, Leg, RewardKind } from '@/ledger/types';
import { assetIdForCode, baseUnits } from './assets';

/**
 * Kraken's LEDGER export, which is the one that holds everything.
 *
 * Kraken offers two exports and only this one is usable for tax. The
 * "trades" export lists trades alone; the ledger lists every movement -
 * deposits, withdrawals, trades, staking rewards, transfers between a
 * user's own wallets - one row per asset per movement. Reconstructing a
 * balance from trades alone is the mistake that had this app reporting
 * EUR 3,900 of bitcoin that was not there, on Bitpanda.
 *
 * Columns are read BY NAME. The export's column order is not a promise
 * anybody made, and a parser reading `fields[8]` keeps working right up
 * until Kraken inserts a column, at which point it reads the fee as the
 * amount and says nothing.
 */
const REQUIRED = ['refid', 'time', 'type', 'asset', 'amount', 'fee'] as const;

/** `txid` and `wallet` are used where present and not required: an older
 *  export predates `wallet`, and a row with no `txid` is still a movement. */
const WALLET_FALLBACK = 'kraken';

export const hasKrakenLedgerHeader = (header: string[]): boolean => {
  const names = new Set(header.map((name) => name.trim().toLowerCase()));
  return REQUIRED.every((column) => names.has(column));
};

export const sniff = (text: string): boolean => {
  try {
    return hasKrakenLedgerHeader(readCsv(text).header);
  } catch {
    // sniff runs against arbitrary input, including a file that is not CSV
    // at all. It answers "no", never throws.
    return false;
  }
};

/**
 * Which ledger row types become which kind of event.
 *
 * `trade` covers both sides of a trade - Kraken writes one row per asset,
 * sharing a `refid` - and the rows of one refid are GROUPED into a single
 * event. Kraken charges the fee on the quote-currency row by default, so a
 * buy's euro row carries `-500 EUR` and a `1.3 EUR` fee while the bitcoin
 * row carries none. Emitted alone, that euro row is an event with no crypto
 * leg for a jurisdiction to attach the fee to, and the fee never reaches
 * the gain. The fee belongs to the trade, so the trade is one event. A
 * refid settled across several fills simply contributes several legs of
 * the same asset, which the host nets per asset.
 *
 * `transfer` is Kraken moving an asset between a user's own wallets, spot
 * to staking and back, written as a debit row and a credit row sharing a
 * refid. They are grouped into one event, so both legs sit at venues the
 * user owns and the fold nets them to zero: no disposal is invented.
 *
 * A type absent from here is SKIPPED and reported, never guessed at.
 */
const KINDS: Record<string, EventKind> = {
  deposit: 'transfer',
  withdrawal: 'transfer',
  trade: 'trade',
  transfer: 'transfer',
  spend: 'trade',
  receive: 'trade',
  staking: 'reward',
  reward: 'reward',
  earn: 'reward',
  dividend: 'reward',
  sale: 'trade',
  // Realised settlements of a margin position, and the fee for keeping one
  // open. `settled` rows stay skipped: they are spot movements the ledger
  // cannot yet pair with the position.
  margin: 'derivative',
  rollover: 'derivative',
};

/** What each reward-bearing row type is. `earn` and `reward` are Kraken's
 *  staking programmes (bonded, flexible, liquid); `dividend` is paid on
 *  tokenised products and the parser knows no more than that. */
const REWARD_KINDS: Record<string, RewardKind> = {
  staking: 'staking',
  reward: 'staking',
  earn: 'staking',
  dividend: 'other',
};

/**
 * The `earn` subtypes that MOVE a holding rather than pay one.
 *
 * Kraken's `earn` row type is two different things and the parser read
 * neither, because it mapped `type` and never looked at `subtype`. An
 * allocation is Kraken shifting a balance between a user's own spot and
 * earn wallets; a reward is yield. Measured on a real 198-row export: 53
 * rewards and 8 allocation rows, and every one of the latter was reported
 * as income for a movement that netted to exactly zero.
 */
const EARN_MOVEMENT_SUBTYPES = new Set([
  'allocation',
  'autoallocation',
  'deallocation',
  'autodeallocation',
  'migration',
]);

const text = (row: CsvRow, column: string): string => {
  const key = Object.keys(row).find(
    (name) => name.trim().toLowerCase() === column,
  );
  return key === undefined ? '' : row[key].trim();
};

/**
 * Kraken writes `2024-03-10 14:22:51.1234`, a UTC instant with no zone
 * marker at all.
 *
 * Read as UTC explicitly. `Date.parse` on a space-separated, zoneless
 * string is implementation-defined and in practice reads LOCAL time, which
 * moves every row by the machine's offset - and at a year boundary moves it
 * into a different tax year.
 */
export const parseKrakenTime = (value: string): number => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?/.exec(
      value.trim(),
    );
  if (match === null) {
    return Number.NaN;
  }
  const [, year, month, day, hour, minute, second, fraction] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    fraction ? Math.round(Number(fraction) * 1000) : 0,
  );
};

export const parse = (input: string): ParseResult => {
  const { header, rows } = readCsv(input);
  if (!hasKrakenLedgerHeader(header)) {
    throw new Error(
      `kraken-csv: this does not look like a Kraken ledger export. It needs the columns ${REQUIRED.join(
        ', ',
      )}, and the file carried: ${header.join(', ') || '(no header)'}`,
    );
  }

  const events: DerivedEvent[] = [];
  // Counted, not listed one line per row: an export can carry hundreds of
  // rows in the same unsupported asset, and three hundred identical
  // sentences is not a report anybody reads.
  const skipped = new Map<string, number>();
  const note = (reason: string) =>
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1);

  /**
   * Rows that are ONE movement in Kraken's own books, gathered by `refid`
   * into one event: the two rows of a trade (fee on the quote row), the
   * debit and credit rows of a transfer between the user's own wallets,
   * and the legs of an earn allocation.
   *
   * Emitted row by row, each carried a single leg: a trade's euro row had no
   * crypto leg to carry its fee, and a transfer's debit row was a disposal
   * of coins the user still holds. `isInternalTransfer` nets per asset
   * WITHIN an event, so grouping is what lets the ledger see the movement
   * for what it is - and grouping too much is harmless, because a group
   * that does not net to zero is reported as the movement the data shows.
   *
   * The event is pushed where the refid's first row sits, so the output
   * keeps the export's order, and filled in as later rows arrive. Fees are
   * appended after every principal, whichever row each came from.
   */
  const groups = new Map<string, { event: DerivedEvent; fees: Leg[] }>();

  /** Per-row ids an earlier version of this parser emitted for rows that
   *  now join a group, so the importer can remove them. Earn allocations
   *  were grouped from the start and name nothing. */
  const supersedes: string[] = [];

  const joinGroup = (
    refid: string,
    kind: EventKind,
    note: string,
    at: number,
    legs: Leg[],
    supersededRowId: string,
  ): void => {
    if (supersededRowId !== '') {
      supersedes.push(supersededRowId);
    }
    const principals = legs.filter((leg) => leg.role !== 'fee');
    const fees = legs.filter((leg) => leg.role === 'fee');
    const group = groups.get(refid);
    if (group) {
      group.event.legs.push(...principals);
      group.fees.push(...fees);
      group.event.timestamp = Math.min(group.event.timestamp, at);
      return;
    }
    const grouped: DerivedEvent = {
      // The bare refid, which cannot collide with the per-row `txid`
      // scheme, so a re-import upserts onto the same event.
      externalId: refid,
      timestamp: at,
      kind,
      origin: 'derived',
      legs: principals,
      note,
    };
    groups.set(refid, { event: grouped, fees });
    events.push(grouped);
  };

  rows.forEach((row, index) => {
    const refid = text(row, 'refid');
    const txid = text(row, 'txid');
    const rawType = text(row, 'type').toLowerCase();
    const subtype = text(row, 'subtype').toLowerCase();
    const code = text(row, 'asset');
    const amount = text(row, 'amount');
    const fee = text(row, 'fee');
    const wallet = text(row, 'wallet') || WALLET_FALLBACK;

    // An id Kraken gave, preferred over a row number: a re-import of a
    // longer export must converge on the same events rather than duplicate
    // them, and events upsert on (sourceId, externalId). `txid` is unique
    // per ledger row; a grouped trade or allocation is keyed by its bare
    // refid instead, below.
    const externalId = txid !== '' ? txid : `${refid}#${index}`;

    if (rawType === '') {
      note('a row with no type');
      return;
    }
    const kind = KINDS[rawType];
    if (kind === undefined) {
      note(`rows of type "${rawType}"`);
      return;
    }

    const assetId = assetIdForCode(code);
    if (assetId === null) {
      // Kraken lists 855 assets. Guessing an id merges two different
      // positions into one, silently.
      note(`holdings in ${code || '(no asset)'}`);
      return;
    }

    const at = parseKrakenTime(text(row, 'time'));
    if (!Number.isFinite(at)) {
      note(`rows with an unreadable time`);
      return;
    }

    const legs: Leg[] = [];
    let moved: Big;
    try {
      moved = new Big(amount === '' ? '0' : amount);
    } catch {
      note('rows with an unreadable amount');
      return;
    }

    if (!moved.eq(0)) {
      // Kraken signs the amount: negative leaves the account.
      const outgoing = moved.lt(0);
      legs.push({
        assetId,
        amount: baseUnits(moved.abs().toString(), assetId),
        direction: outgoing ? 'out' : 'in',
        venue: wallet,
        role: 'principal',
      });
    }

    // The fee is a separate, always-positive column and is charged on top
    // of the amount. Omitting it is how a balance drifts upward by every
    // fee ever paid - the same leg the Bitpanda and Ethereum modules
    // needed before their numbers reconciled.
    if (fee !== '') {
      try {
        const charged = new Big(fee);
        if (charged.gt(0)) {
          legs.push({
            assetId,
            amount: baseUnits(charged.toString(), assetId),
            direction: 'out',
            venue: wallet,
            role: 'fee',
          });
        }
      } catch {
        note('rows with an unreadable fee');
        return;
      }
    }

    if (legs.length === 0) {
      // A zero-amount, zero-fee row moved nothing.
      return;
    }

    // An allocation's legs join their refid's group instead of becoming an
    // event of their own.
    if (
      rawType === 'earn' &&
      EARN_MOVEMENT_SUBTYPES.has(subtype) &&
      refid !== ''
    ) {
      joinGroup(
        refid,
        'transfer',
        `Kraken earn ${subtype} ${refid}`,
        at,
        legs,
        '',
      );
      return;
    }

    // A trade's rows, or a transfer's, join their refid's group too.
    if ((rawType === 'trade' || rawType === 'transfer') && refid !== '') {
      joinGroup(refid, kind, `Kraken ${rawType} ${refid}`, at, legs, txid);
      return;
    }

    events.push({
      externalId,
      timestamp: at,
      kind,
      origin: 'derived',
      legs,
      // An earn allocation that reaches here (no refid to group on) moves a
      // holding rather than paying one, so it is not typed as a reward.
      ...(kind === 'reward' &&
      !(rawType === 'earn' && EARN_MOVEMENT_SUBTYPES.has(subtype))
        ? { rewardKind: REWARD_KINDS[rawType] }
        : {}),
      ...(kind === 'derivative'
        ? {
            derivative: {
              kind: rawType === 'rollover' ? 'rollover' : 'pnl',
              product: 'margin',
            },
          }
        : {}),
      // Provenance only, never parsed: the refid is what ties the two rows
      // of one trade together in Kraken's own export, which is what a
      // person needs to follow a figure back to their statement.
      note: refid === '' ? undefined : `Kraken ${rawType} ${refid}`,
    });
  });

  for (const { event, fees } of groups.values()) {
    event.legs.push(...fees);
  }

  return {
    events,
    skipped: [...skipped.entries()].map(([reason, count]) =>
      count === 1 ? `Skipped ${reason}` : `Skipped ${count} ${reason}`,
    ),
    supersedes,
  };
};
