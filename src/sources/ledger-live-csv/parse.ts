import { readCsv } from '@/sources/csv/readCsv';
import {
  AmbiguousDecimalError,
  makeSkipLog,
  normaliseDecimal,
  toBaseUnits,
} from '@/sources/csv/ledgerShape';
import Big from 'big.js';
import { entriesFor, resolveSymbol } from '@/assets/catalogue';
import type { AssetEntry } from '@/assets/catalogue';
import type { ParseResult } from '@/sources/csv/types';
import type { DerivedEvent } from '@/sources/types';
import type { Leg } from '@/ledger/types';
import { fnv64Hex } from '@/sources/csv/identity';

/**
 * Ledger Live's "Operation history" export.
 *
 * Format taken from Ledger's own exporter (csvExport.ts): twelve columns,
 * ISO dates, UNSIGNED amounts with the direction in the operation type, the
 * fee in the parent account's coin (empty for a token account, whose fee sits
 * on the parent's own row), commas stripped from values - though a German
 * Ledger Live writes a decimal comma, hence `normaliseDecimal`.
 *
 * A native OUT's amount includes its fee, as Ledger's own operation type
 * documents, so sends are booked net of the fee: principal = amount - fee,
 * a fee event alone when that is zero, a skip when it is negative.
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

const UNSIGNED_DECIMAL = /^\d*\.?\d+$/;

const lower = (names: string[]): string[] =>
  names.map((name) => name.trim().toLowerCase());

export const sniff = (text: string): boolean => {
  try {
    const { header } = readCsv(text, { delimiter: 'auto' });
    const names = new Set(lower(header));
    return REQUIRED.every((column) => names.has(column.toLowerCase()));
  } catch {
    return false;
  }
};

/**
 * Which catalogue entry an account's ticker is.
 *
 * A native coin first, whatever the address looks like: POL, BNB, AVAX and
 * ETC accounts all carry 0x addresses and are not Ethereum tokens. A token
 * only on an 0x account, because the catalogue's tokens are Ethereum's: a
 * Tron USDT or a Solana USDC shares the ticker, not the asset. An ambiguous
 * ticker gets one retry on Ethereum, unless a native coin is among its
 * candidates: MATIC is both the Polygon coin's old name and an ERC-20, and
 * an 0x address cannot tell them apart, so it skips.
 */
const resolveAccountAsset = (
  ticker: string,
  isEthAddress: boolean,
): AssetEntry | undefined => {
  const entry = resolveSymbol(ticker);
  if (entry?.kind === 'native') {
    return entry;
  }
  if (!isEthAddress) {
    return undefined;
  }
  if (entry !== undefined) {
    return entry;
  }
  // Ambiguous: an Ethereum token may answer, unless one of the candidates
  // is a native coin, which the 0x address could just as well belong to.
  if (entriesFor(ticker).some((candidate) => candidate.kind === 'native')) {
    return undefined;
  }
  return resolveSymbol(ticker, { chain: 'eth' });
};

export const parse = (input: string): ParseResult => {
  const { header, rows } = readCsv(input, { delimiter: 'auto' });
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
  const seen = new Map<string, number>();

  for (const row of rows) {
    const cell = (name: string): string => (row[name] ?? '').trim();
    const type = cell('Operation Type').toUpperCase();
    const ticker = cell('Currency Ticker');
    const xpub =
      cell('Account xpub') ||
      (cell('Account Name') ? `name:${cell('Account Name')}` : '');
    if (xpub === '') {
      skipped.note('rows without an account');
      continue;
    }
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
        skipped.note(`unparseable amounts in ${ticker || '(no ticker)'}`);
        continue;
      }
      throw error;
    }
    // Unsigned decimals only, checked per row: a value the unit boundary
    // would refuse must skip this row, not abort the whole import.
    if (!UNSIGNED_DECIMAL.test(amount) || !UNSIGNED_DECIMAL.test(fee)) {
      skipped.note(`unparseable amounts in ${ticker || '(no ticker)'}`);
      continue;
    }
    const hasAmount = Number(amount) > 0;
    const hasFee = Number(fee) > 0;

    // Nothing moved and nothing was paid: not worth a row.
    if (isAction && !hasFee) {
      continue;
    }

    const isEthAddress = xpub.startsWith('0x');
    const venue = `ledger-live:${isEthAddress ? xpub.toLowerCase() : xpub}`;
    const entry = resolveAccountAsset(ticker, isEthAddress);
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

    // Gas is paid in the chain's own coin and sits on the PARENT account's
    // row with the same hash. A token row never books a fee of its own, even
    // when its fee column is filled: that would count the gas twice.
    const isToken = entry.kind === 'token';
    const nativeId = entry.kind === 'native' ? entry.id : undefined;

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
      if (isToken) {
        continue;
      }
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
      // A native OUT's amount INCLUDES its fee (Ledger's own operation type:
      // "in OUT case, it includes the fees"), so the principal is what is
      // left after the fee. A token's amount does not: its gas is on the
      // parent's row.
      let principal = amount;
      if (type === 'OUT' && nativeId !== undefined && hasFee && !failed) {
        const net = new Big(amount).minus(fee);
        if (net.lt(0)) {
          skipped.note('amounts below the fee');
          continue;
        }
        principal = net.toFixed();
      }
      if (Number(principal) > 0 && !failed) {
        legs.push(
          leg(entry.id, principal, type === 'IN' ? 'in' : 'out', 'principal'),
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

    const key = `${hash}|${type}|${ticker}|${amount}|${xpub}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    events.push({
      externalId: fnv64Hex(key + (occurrence === 0 ? '' : `|${occurrence}`)),
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
