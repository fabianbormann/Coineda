import Big from 'big.js';
import { resolveSymbol } from '@/assets/catalogue';
import { isFiatAsset } from '@/ledger/balances';
import { fnv64Hex } from '@/sources/csv/identity';
import {
  makeSkipLog,
  normaliseDecimal,
  stripThousands,
  toBaseUnits,
} from '@/sources/csv/ledgerShape';
import { readCsv, type CsvRow } from '@/sources/csv/readCsv';
import type { DerivedEvent } from '@/sources/types';
import type { EventKind, Leg, RewardKind } from '@/ledger/types';
import { parseMappedDate } from './dates';
import type { CsvMapping, MappedParseResult } from './types';

const IMPORTER = 'mapped-csv';
const DAY = 24 * 60 * 60 * 1000;

const EVENT_KINDS: EventKind[] = [
  'trade',
  'transfer',
  'reward',
  'fee',
  'fiat-in',
  'fiat-out',
  'derivative',
];

/** The fiat asset id a mapping's fiat counter names, or undefined when the
 *  mapping names none or names something that is not a fiat currency. */
export const counterFiatOf = (mapping: CsvMapping): string | undefined => {
  if (mapping.counter?.kind !== 'fiat') return undefined;
  const id = resolveSymbol(mapping.counter.currency.trim())?.id;
  return id !== undefined && isFiatAsset(id) ? id : undefined;
};

/** Mapped column names that the file's header does not carry. A misspelt
 *  optional column would otherwise read as empty on every row, silently. */
export const missingColumns = (
  mapping: CsvMapping,
  header: string[],
): string[] => {
  const present = new Set(header);
  return Object.values(mapping.columns).filter(
    (name): name is string => !!name && !present.has(name),
  );
};

export class MappingColumnError extends Error {
  constructor(readonly columns: string[]) {
    super(`The file has no column named ${columns.join(', ')}`);
    this.name = 'MappingColumnError';
  }
}

/**
 * The mapping's problems as translation keys; empty means it can be used.
 * Checked before a file is parsed, so a half-finished mapping is told what is
 * missing rather than producing a file of skipped rows.
 */
export const validateMapping = (
  mapping: CsvMapping,
  header?: string[],
): string[] => {
  const problems: string[] = [];
  const { date, asset, amount, type } = mapping.columns;
  if (header) {
    for (const name of missingColumns(mapping, header)) {
      problems.push(`Column ${name} is not in the file`);
    }
  }
  if (!date || !asset || !amount) {
    problems.push('Map the date, asset and amount columns');
  }
  if (mapping.direction.mode === 'type') {
    if (!type) {
      problems.push('Direction by type needs a type column');
    }
    const outgoing = new Set(mapping.direction.out);
    if (mapping.direction.in.some((value) => outgoing.has(value))) {
      problems.push('A type value cannot be both incoming and outgoing');
    }
  }
  if (
    mapping.counter?.kind === 'fiat' &&
    counterFiatOf(mapping) === undefined
  ) {
    problems.push('Choose the fiat currency of the price column');
  }
  return problems;
};

/** A cell's whole-unit amount as a decimal string in the mapping's style,
 *  or undefined when it is not one. Never guesses between the two styles. */
const wholeOf = (raw: string, decimal: CsvMapping['decimal']) => {
  const value = raw.trim().replace(/^\+/, '');
  if (decimal === 'comma') {
    // A dot in a decimal-comma file is a thousands mark or a mistake, and
    // reading "1.234" as 1.234 instead of 1234 is a thousandfold error.
    if (value.includes('.')) return undefined;
    try {
      return normaliseDecimal(value);
    } catch {
      return undefined;
    }
  }
  // Commas in a decimal-dot file are thousands groups only where that is
  // unmistakable: "0,5" or "4500,50" is a decimal comma in the wrong
  // style, and stripping it would book it ten or a hundred times over.
  return stripThousands(value);
};

class AmountError extends Error {}

/** Base units of a cell for an asset. Fiat stays whole units, 2 decimals. */
const unitsOf = (raw: string, assetId: string, m: CsvMapping): string => {
  const whole = wholeOf(raw, m.decimal);
  if (whole === undefined) throw new AmountError(raw);
  try {
    new Big(whole);
  } catch {
    throw new AmountError(raw);
  }
  try {
    if (isFiatAsset(assetId)) {
      return toBaseUnits(
        IMPORTER,
        new Big(whole).round(2, Big.roundHalfUp).toFixed(2),
        assetId,
      );
    }
    return toBaseUnits(IMPORTER, whole, assetId);
  } catch {
    throw new AmountError(raw);
  }
};

const absOf = (raw: string) => raw.trim().replace(/^[+-]/, '');
const isNegative = (raw: string) => raw.trim().startsWith('-');

type Parsed = {
  index: number;
  at: number;
  rawType: string;
  kind: EventKind;
  asset: string; // asset id
  assetCode: string;
  amountRaw: string;
  direction: 'in' | 'out';
  fee: string;
  feeAssetCode: string;
  price: string;
  counterAssetCode: string;
  counterAmount: string;
  tradeId: string;
  txHash: string;
  key: string;
};

export const parseMapped = (
  text: string,
  mapping: CsvMapping,
): MappedParseResult => {
  const m = mapping;
  const c = m.columns;
  const { header, rows } = readCsv(text, { delimiter: m.delimiter });
  const missing = missingColumns(m, header);
  if (missing.length > 0) throw new MappingColumnError(missing);
  const skip = makeSkipLog();
  const unresolved = new Set<string>();
  const venue = `csv:${m.venueLabel}`;
  const cell = (row: CsvRow, column?: string): string =>
    column ? (row[column] ?? '').trim() : '';

  const resolve = (code: string): string | undefined => {
    const id = resolveSymbol(code.trim())?.id;
    if (id === undefined) {
      unresolved.add(code.trim());
      skip.note(`holdings in ${code.trim() || '(no asset)'}`);
    }
    return id;
  };

  const parsed: Parsed[] = [];
  rows.forEach((row, index) => {
    const rawType = cell(row, c.type);
    const kind = c.type ? m.kinds[rawType] : m.kinds['*'];
    if (kind === undefined) {
      skip.note(
        c.type ? `rows of type "${rawType}"` : 'rows with no kind mapped',
      );
      return;
    }
    const at = parseMappedDate(cell(row, c.date), m.dateFormat, m.timeZone);
    if (at === undefined) {
      skip.note('rows with an unreadable date');
      return;
    }
    const amountRaw = cell(row, c.amount);
    if (amountRaw === '') {
      skip.note('rows with no amount');
      return;
    }

    let direction: 'in' | 'out';
    if (m.direction.mode === 'sign') {
      direction = isNegative(amountRaw) ? 'out' : 'in';
    } else if (m.direction.in.includes(rawType)) {
      direction = 'in';
    } else if (m.direction.out.includes(rawType)) {
      direction = 'out';
    } else {
      skip.note(`rows of type "${rawType}" with no direction`);
      return;
    }

    const assetCode = cell(row, c.asset);
    const fee = cell(row, c.fee);
    const price = cell(row, c.price);
    const counterAssetCode = cell(row, c.counterAsset);
    const counterAmount = cell(row, c.counterAmount);
    const tradeId = cell(row, c.tradeId);
    const txHash = cell(row, c.txHash);
    const feeAssetCode = cell(row, c.feeAsset);
    const key = [
      cell(row, c.date),
      rawType,
      assetCode,
      amountRaw,
      fee,
      tradeId,
      txHash,
    ].join('|');
    parsed.push({
      index,
      at,
      rawType,
      kind,
      asset: '',
      assetCode,
      amountRaw,
      direction,
      fee,
      feeAssetCode,
      price,
      counterAssetCode,
      counterAmount,
      tradeId,
      txHash,
      key,
    });
  });

  // Group rows sharing a trade id. A group spanning more than a day is split
  // into runs that each start within a day of their first row: one id reused
  // weeks apart is two trades, not one.
  const runs: Parsed[][] = [];
  const byTrade = new Map<string, Parsed[]>();
  for (const row of parsed) {
    if (row.tradeId === '') {
      runs.push([row]);
    } else {
      const list = byTrade.get(row.tradeId) ?? [];
      list.push(row);
      byTrade.set(row.tradeId, list);
    }
  }
  const tradeRuns = new Map<Parsed[], string>();
  for (const [tradeId, list] of byTrade) {
    const sorted = [...list].sort((a, b) => a.at - b.at);
    const split: Parsed[][] = [];
    for (const row of sorted) {
      const last = split[split.length - 1];
      if (last && row.at - last[0].at <= DAY) last.push(row);
      else split.push([row]);
    }
    if (split.length > 1) skip.note('trade groups spanning more than a day');
    split.forEach((run, n) => {
      runs.push(run);
      tradeRuns.set(run, n === 0 ? tradeId : `${tradeId}|${n}`);
    });
  }
  runs.sort((a, b) => a[0].index - b[0].index);

  const seen = new Map<string, number>();
  const idFor = (key: string): string => {
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return fnv64Hex(key + (occurrence === 0 ? '' : `|${occurrence}`));
  };

  const events: DerivedEvent[] = [];
  const counterFiat = counterFiatOf(m);

  const leg = (
    assetId: string,
    raw: string,
    direction: 'in' | 'out',
    role: Leg['role'],
  ): Leg => ({
    assetId,
    amount: unitsOf(absOf(raw), assetId, m),
    direction,
    venue,
    role,
  });

  /** The fee leg of a row, or null when it has none. */
  const feeLeg = (row: Parsed, defaultAsset: string): Leg | null => {
    if (row.fee === '' || new Big(0).eq(safeBig(row.fee, m))) return null;
    const assetId =
      row.feeAssetCode === '' ? defaultAsset : resolve(row.feeAssetCode);
    if (assetId === undefined) throw new SkippedRow();
    return leg(assetId, row.fee, 'out', 'fee');
  };

  const build = (run: Parsed[]): DerivedEvent | null => {
    const grouped = run.length > 1;
    for (const row of run) {
      const id = resolve(row.assetCode);
      if (id === undefined) return null;
      row.asset = id;
    }
    const first = run[0];
    const legs: Leg[] = [];
    let kind: EventKind = first.kind;
    let rewardKind: RewardKind | undefined;
    let txHash = first.txHash;
    let counterAsset: string | undefined;

    if (grouped) {
      kind = 'trade';
      for (const row of run) {
        if (new Big(safeBig(absOf(row.amountRaw), m)).eq(0)) continue;
        // A fee on its own row of the order is a cost of the trade, never
        // a principal disposal: as a principal it would make two fiat legs
        // and lose the trade's consideration.
        legs.push(
          row.kind === 'fee'
            ? leg(row.asset, row.amountRaw, 'out', 'fee')
            : leg(row.asset, row.amountRaw, row.direction, 'principal'),
        );
      }
      for (const row of run) {
        const fee = feeLeg(row, row.asset);
        if (fee) legs.push(fee);
      }
      if (
        !legs.some((l) => l.direction === 'in' && l.role === 'principal') ||
        !legs.some((l) => l.direction === 'out' && l.role === 'principal')
      ) {
        skip.note('trade groups without both sides');
        return null;
      }
      txHash = run.find((row) => row.txHash !== '')?.txHash ?? '';
    } else {
      const row = first;
      if (new Big(safeBig(absOf(row.amountRaw), m)).eq(0)) {
        skip.note('rows with a zero amount');
        return null;
      }
      if (kind === 'fee') {
        legs.push(leg(row.asset, row.amountRaw, 'out', 'fee'));
      } else if (kind === 'reward') {
        legs.push(leg(row.asset, row.amountRaw, 'in', 'principal'));
        // Never guessed from the label ("Unstaking" is not staking income).
        rewardKind = 'other';
      } else if (kind === 'fiat-in' || kind === 'fiat-out') {
        legs.push(
          leg(
            row.asset,
            row.amountRaw,
            kind === 'fiat-in' ? 'in' : 'out',
            'principal',
          ),
        );
      } else {
        legs.push(leg(row.asset, row.amountRaw, row.direction, 'principal'));
        if (kind === 'trade') {
          const counter = counterLeg(row);
          if (counter === null) return null;
          legs.push(counter);
          counterAsset = counter.assetId;
        }
      }
      const defaultFee = counterAsset ?? row.asset;
      const fee = feeLeg(row, defaultFee);
      if (fee) legs.push(fee);
    }

    let earliest = first.at;
    for (const row of run) if (row.at < earliest) earliest = row.at;
    const type = first.rawType || kind;
    const key = grouped
      ? `trade|${tradeRuns.get(run) ?? first.tradeId}`
      : first.key;
    return {
      externalId: grouped ? fnv64Hex(key) : idFor(key),
      timestamp: earliest,
      kind,
      origin: 'derived',
      legs,
      ...(rewardKind ? { rewardKind } : {}),
      ...(txHash !== '' ? { txHash } : {}),
      note: `${m.venueLabel} · ${type}`,
    };
  };

  /** The other side of a single-row trade, from a counter asset and amount
   *  or from price x amount. */
  const counterLeg = (row: Parsed): Leg | null => {
    const direction = row.direction === 'in' ? 'out' : 'in';
    let counterId: string | undefined;
    if (row.counterAssetCode !== '') {
      counterId = resolve(row.counterAssetCode);
      if (counterId === undefined) return null;
    } else if (counterFiat !== undefined) {
      counterId = counterFiat;
    } else {
      skip.note('trades with no counter asset');
      return null;
    }

    if (row.counterAmount !== '') {
      // Zero would book a disposal for nothing (a fabricated loss of the
      // whole cost basis); a negative counter contradicts the row.
      if (
        isNegative(row.counterAmount) ||
        !safeBig(row.counterAmount, m).gt(0)
      ) {
        throw new AmountError(row.counterAmount);
      }
      const counter = leg(counterId, row.counterAmount, direction, 'principal');
      if (new Big(counter.amount).eq(0))
        throw new AmountError(row.counterAmount);
      return counter;
    }
    if (row.price === '') {
      skip.note('trades with no price or counter amount');
      return null;
    }
    const price = wholeOf(row.price, m.decimal);
    const amount = wholeOf(absOf(row.amountRaw), m.decimal);
    if (price === undefined || amount === undefined) {
      skip.note('rows with unparseable amounts');
      return null;
    }
    if (new Big(price).lte(0)) {
      skip.note('rows with unparseable amounts');
      return null;
    }
    const product = new Big(price).times(amount);
    const rounded = isFiatAsset(counterId)
      ? product.round(2, Big.roundHalfUp)
      : product;
    if (!rounded.gt(0)) {
      skip.note('rows with unparseable amounts');
      return null;
    }
    // Already a dot decimal: bypass the style conversion.
    return {
      assetId: counterId,
      amount: toBaseUnits(IMPORTER, rounded.toFixed(), counterId),
      direction,
      venue,
      role: 'principal',
    };
  };

  for (const run of runs) {
    try {
      const event = build(run);
      if (event) events.push(event);
    } catch (error) {
      if (error instanceof AmountError || error instanceof SkippedRow) {
        if (error instanceof AmountError)
          skip.note('rows with unparseable amounts');
        continue;
      }
      // toBaseUnits / Big failures on a price or amount cell.
      skip.note('rows with unparseable amounts');
    }
  }

  // A sign-based direction over a column that never goes negative (or never
  // positive) books every row one way. That is a wrong setting far more often
  // than a real file, and nothing else would say so.
  const warnings: string[] = [];
  if (m.direction.mode === 'sign' && events.length > 0) {
    const principal = events.flatMap((e) =>
      e.legs.filter((l) => l.role === 'principal'),
    );
    if (!principal.some((l) => l.direction === 'out')) {
      warnings.push('No outgoing rows: check the direction setting');
    }
    if (!principal.some((l) => l.direction === 'in')) {
      warnings.push('No incoming rows: check the direction setting');
    }
  }

  return {
    events,
    skipped: skip.lines(),
    unresolved: [...unresolved],
    warnings,
  };
};

class SkippedRow extends Error {}

/** A Big for a cell already known to be shaped like a number, else throws
 *  AmountError so the row is skipped as unparseable. */
const safeBig = (raw: string, m: CsvMapping): Big => {
  const whole = wholeOf(raw, m.decimal);
  if (whole === undefined) throw new AmountError(raw);
  try {
    return new Big(whole);
  } catch {
    throw new AmountError(raw);
  }
};

export type MappedPreview = {
  byKind: Record<EventKind, number>;
  skipped: string[];
  unresolved: string[];
  sample: DerivedEvent[];
  warnings: string[];
};

export const previewMapped = (
  text: string,
  mapping: CsvMapping,
): MappedPreview => {
  const { events, skipped, unresolved, warnings } = parseMapped(text, mapping);
  const byKind = Object.fromEntries(
    EVENT_KINDS.map((kind) => [kind, 0]),
  ) as Record<EventKind, number>;
  for (const event of events) byKind[event.kind] += 1;
  return {
    byKind,
    skipped,
    unresolved,
    sample: events.slice(0, 5),
    warnings,
  };
};
