import { readCsv } from '@/sources/csv/readCsv';
import {
  AmbiguousDecimalError,
  makeSkipLog,
  normaliseDecimal,
  toBaseUnits,
} from '@/sources/csv/ledgerShape';
import { ASSET_CATALOGUE, resolveSymbol } from '@/assets/catalogue';
import type { ParseResult } from '@/sources/csv/types';
import type { DerivedEvent } from '@/sources/types';
import type { Leg } from '@/ledger/types';

/**
 * Ledger Live's "Operation history" export.
 *
 * Format taken from Ledger's own exporter (csvExport.ts): twelve columns,
 * ISO dates, UNSIGNED amounts with the direction in the operation type, the
 * fee in the parent account's coin (empty for a token account, whose fee sits
 * on the parent's own row), commas stripped from values - though a German
 * Ledger Live writes a decimal comma, hence `normaliseDecimal`.
 */
const REQUIRED = [
  'Operation Date',
  'Operation Type',
  'Operation Amount',
  'Account xpub',
] as const;

/** Chain actions that move nothing: a fee event when a fee was paid,
 *  otherwise not worth a row. */
const CHAIN_ACTIONS = new Set([
  'DELEGATE',
  'UNDELEGATE',
  'REDELEGATE',
  'STAKE',
  'UNSTAKE',
  'BOND',
  'UNBOND',
  'WITHDRAW_UNBONDED',
  'WITHDRAW_UNSTAKED',
  'FINALIZE_UNSTAKE',
  'FREEZE',
  'UNFREEZE',
  'LOCK',
  'UNLOCK',
  'VOTE',
  'NOMINATE',
  'CHILL',
  'APPROVE',
  'OPT_IN',
  'OPT_OUT',
  'REVEAL',
  'CREATE',
  'ACTIVATE',
  'REGISTER',
  'CONTRACT_CALL',
  'UPDATE_ACCOUNT',
  'SET_CONTROLLER',
]);

const lower = (names: string[]): string[] =>
  names.map((name) => name.trim().toLowerCase());

export const sniff = (text: string): boolean => {
  try {
    const { header } = readCsv(text);
    const names = new Set(lower(header));
    return REQUIRED.every((column) => names.has(column.toLowerCase()));
  } catch {
    return false;
  }
};

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

const fnv1a64 = (text: string, seed: bigint): string => {
  let hash = seed;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
};

/**
 * A synchronous 128-bit-wide identity (two FNV-1a 64 passes), because
 * `FileSourceModule.parse` is synchronous and Web Crypto is not. It is a
 * dedupe key over a few thousand rows of one user's own file, not a security
 * boundary.
 */
const identity = (text: string): string =>
  fnv1a64(text, FNV_OFFSET) + fnv1a64(`|${text}`, FNV_OFFSET ^ 0x9e3779b9n);

export const parse = (input: string): ParseResult => {
  const { header, rows } = readCsv(input);
  const have = new Set(lower(header));
  const missing = REQUIRED.filter((column) => !have.has(column.toLowerCase()));
  if (missing.length > 0) {
    throw new Error(
      `ledger-live-csv: this does not look like a Ledger Live operation history. It needs the columns ${REQUIRED.join(
        ', ',
      )}, and the file carried: ${header.join(', ') || '(empty file)'}`,
    );
  }

  const events: DerivedEvent[] = [];
  const skipped = makeSkipLog();

  for (const row of rows) {
    const cell = (name: string): string => (row[name] ?? '').trim();
    const type = cell('Operation Type').toUpperCase();
    const ticker = cell('Currency Ticker');
    const xpub = cell('Account xpub');
    const hash = cell('Operation Hash');
    const failed = cell('Status').toLowerCase() === 'failed';

    const isReward = type === 'REWARD' || type === 'REWARD_PAYOUT';
    const isMove = type === 'IN' || type === 'OUT';
    const isFees = type === 'FEES';
    const isAction = CHAIN_ACTIONS.has(type);
    if (!isMove && !isFees && !isReward && !isAction) {
      skipped.note(`${type || '(no type)'} operations`);
      continue;
    }

    const when = Date.parse(cell('Operation Date'));
    if (!Number.isFinite(when)) {
      skipped.note('rows with an unreadable date');
      continue;
    }

    let amount: string;
    let fee: string;
    try {
      amount = normaliseDecimal(cell('Operation Amount') || '0');
      fee = normaliseDecimal(cell('Operation Fees') || '0');
    } catch (error) {
      if (error instanceof AmbiguousDecimalError) {
        skipped.note('unparseable amounts');
        continue;
      }
      throw error;
    }
    const hasAmount = Number(amount) > 0;
    const hasFee = Number(fee) > 0;

    // Nothing moved and nothing was paid: not worth a row.
    if (isAction && !hasFee) {
      continue;
    }

    const isEthAddress = xpub.startsWith('0x');
    const venue = `ledger-live:${isEthAddress ? xpub.toLowerCase() : xpub}`;
    const entry = resolveSymbol(
      ticker,
      isEthAddress ? { chain: 'eth' } : undefined,
    );
    if (entry === undefined) {
      skipped.note(`holdings in ${ticker || '(no ticker)'}`);
      continue;
    }

    const leg = (
      assetId: string,
      whole: string,
      direction: 'in' | 'out',
      role: Leg['role'],
    ): Leg => ({
      assetId,
      amount: toBaseUnits('ledger-live-csv', whole, assetId),
      direction,
      venue,
      role,
    });

    // Gas is paid in the chain's own coin, whatever the token moved.
    const nativeId =
      entry.kind === 'native'
        ? entry.id
        : ASSET_CATALOGUE.find(
            (candidate) =>
              candidate.kind === 'native' && candidate.chain === entry.chain,
          )?.id;

    const legs: Leg[] = [];
    let kind: DerivedEvent['kind'];
    let rewardKind: DerivedEvent['rewardKind'];

    if (isFees) {
      // The fee column is the fee; the amount repeats it.
      const paid = hasFee ? fee : amount;
      if (Number(paid) <= 0 || nativeId === undefined) {
        continue;
      }
      legs.push(leg(nativeId, paid, 'out', 'fee'));
      kind = 'fee';
    } else if (isAction) {
      if (nativeId === undefined) {
        skipped.note(`fees in ${ticker}`);
        continue;
      }
      legs.push(leg(nativeId, fee, 'out', 'fee'));
      kind = 'fee';
    } else if (isReward) {
      if (failed || !hasAmount) {
        continue;
      }
      legs.push(leg(entry.id, amount, 'in', 'principal'));
      kind = 'reward';
      rewardKind = 'staking';
    } else {
      if (hasAmount && !failed) {
        legs.push(
          leg(entry.id, amount, type === 'IN' ? 'in' : 'out', 'principal'),
        );
      }
      if (type === 'OUT' && hasFee && nativeId !== undefined) {
        legs.push(leg(nativeId, fee, 'out', 'fee'));
      }
      if (legs.length === 0) {
        continue;
      }
      kind = legs.some((l) => l.role === 'principal') ? 'transfer' : 'fee';
    }

    events.push({
      externalId: identity(`${hash}|${type}|${ticker}|${amount}|${xpub}`),
      timestamp: when,
      kind,
      origin: 'derived',
      legs,
      ...(rewardKind ? { rewardKind } : {}),
      ...(hash !== '' ? { txHash: hash } : {}),
      note: `Ledger Live · ${cell('Account Name')}`,
    });
  }

  return { events, skipped: skipped.lines() };
};
