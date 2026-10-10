import Big from 'big.js';
import { symbolOf, toWholeUnits } from '@/components/money/asset';
import type { OwnCategory, OwnFigures } from './aggregate';
import { resolveCarfAsset } from './assets';
import type {
  CarfAssetReport,
  CarfBlock,
  CarfCategory,
  CarfMessage,
  CarfTin,
  CarfUser,
} from './types';

/**
 * Compare what a provider reported to the tax office with the client's own
 * ledger, per asset and CARF block. Pure: the caller supplies the file hash
 * and the aggregated own figures.
 */

export type Verdict =
  | 'match'
  | 'differs'
  | 'missing-own'
  | 'not-reported'
  | 'unpriced'
  | 'not-compared';

export type ReportedSide = {
  transactions?: number;
  units: string;
  amount: string;
  currency: string;
  byType: Record<
    string,
    { transactions?: number; units: string; amount: string }
  >;
};

/** `units` and `fees` are whole units; `units` is rounded to 6 decimals. */
export type OwnSide = {
  transactions: number;
  units: string;
  amount?: string;
  fees: string;
  fiatFees?: string;
  byType: Record<
    string,
    { transactions: number; units: string; amount?: string }
  >;
};

export type ReconciliationRow = {
  assetId: string;
  symbol: string;
  category: CarfCategory;
  reported?: ReportedSide;
  own?: OwnSide;
  delta: { transactions?: number; units?: string; amount?: string };
  verdict: Verdict;
  /** A translation key. */
  note?: string;
  noteParams?: Record<string, string>;
};

export type CarfReconciliation = {
  messageRefId: string;
  messageTypeIndic: string;
  reportingPeriod: string;
  year: number;
  timestamp: string;
  provider: string;
  user: {
    name: string;
    tins: CarfTin[];
    docRefId: string;
    docTypeIndic: string;
  };
  sourceIds: string[];
  sourceLabels: string[];
  fileHash: string;
  baseCurrency: string;
  rows: ReconciliationRow[];
  unrecognised: CarfAssetReport[];
  summary: Record<Verdict | 'not-recognised', number>;
};

export const CATEGORY_ORDER: CarfCategory[] = [
  'fiat-in',
  'fiat-out',
  'crypto-in',
  'crypto-out',
  'transfer-in',
  'transfer-out',
  'wallet',
  'rrpt',
];

const plain = (value: Big): string => {
  const text = value.toFixed();
  return text === '-0' ? '0' : text;
};

const roundUnits = (units: string): string =>
  plain(new Big(units).round(6, Big.roundHalfUp));

const wholeRounded = (units: string, assetId: string): string =>
  roundUnits(toWholeUnits(units, assetId));

const sumReported = (blocks: CarfBlock[]): ReportedSide => {
  let units = new Big(0);
  let amount = new Big(0);
  let transactions: number | undefined;
  const currencies = new Set(blocks.map((b) => b.currency));
  const byType: ReportedSide['byType'] = {};
  const typed: Record<
    string,
    { transactions?: number; units: Big; amount: Big }
  > = {};
  for (const b of blocks) {
    units = units.plus(b.units);
    amount = amount.plus(b.amount);
    if (b.transactions !== undefined) {
      transactions = (transactions ?? 0) + b.transactions;
    }
    const t = (typed[b.type ?? ''] ??= {
      units: new Big(0),
      amount: new Big(0),
    });
    t.units = t.units.plus(b.units);
    t.amount = t.amount.plus(b.amount);
    if (b.transactions !== undefined) {
      t.transactions = (t.transactions ?? 0) + b.transactions;
    }
  }
  for (const [type, t] of Object.entries(typed)) {
    byType[type] = {
      ...(t.transactions !== undefined ? { transactions: t.transactions } : {}),
      units: plain(t.units),
      amount: plain(t.amount),
    };
  }
  return {
    ...(transactions !== undefined ? { transactions } : {}),
    units: plain(units),
    amount: plain(amount),
    // Amounts in different currencies cannot be added: no single currency.
    currency: currencies.size === 1 ? blocks[0].currency : '',
    byType,
  };
};

const ownSide = (category: OwnCategory, assetId: string): OwnSide => ({
  transactions: category.transactions,
  units: wholeRounded(category.units, assetId),
  ...(category.amount !== undefined ? { amount: category.amount } : {}),
  fees: toWholeUnits(category.fees, assetId),
  ...(category.fiatFees !== undefined ? { fiatFees: category.fiatFees } : {}),
  byType: Object.fromEntries(
    Object.entries(category.byType).map(([type, t]) => [
      type,
      {
        transactions: t.transactions,
        units: wholeRounded(t.units, assetId),
        ...(t.amount !== undefined ? { amount: t.amount } : {}),
      },
    ]),
  ),
});

const verdictOf = (
  category: CarfCategory,
  reported: ReportedSide | undefined,
  own: OwnSide | undefined,
  notReported: boolean,
  baseCurrency: string,
): Verdict => {
  if (category === 'rrpt') return 'not-compared';
  if (!own) return 'missing-own';
  if (!reported || notReported) return 'not-reported';
  if (reported.currency.toLowerCase() !== baseCurrency.toLowerCase()) {
    return 'not-compared';
  }
  const countsAgree =
    reported.transactions === undefined ||
    reported.transactions === own.transactions;
  const unitsAgree = new Big(reported.units).eq(own.units);
  if (own.amount === undefined) {
    return countsAgree && unitsAgree ? 'unpriced' : 'differs';
  }
  const r = new Big(reported.amount);
  const pct = r.times('0.01').abs();
  const tolerance = pct.gt(1) ? pct : new Big(1);
  const amountAgrees = r.minus(own.amount).abs().lte(tolerance);
  return countsAgree && unitsAgree && amountAgrees ? 'match' : 'differs';
};

const deltaOf = (
  reported: ReportedSide | undefined,
  own: OwnSide | undefined,
): ReconciliationRow['delta'] => {
  if (!reported || !own) return {};
  const delta: ReconciliationRow['delta'] = {};
  if (reported.transactions !== undefined) {
    delta.transactions = own.transactions - reported.transactions;
  }
  delta.units = plain(new Big(own.units).minus(reported.units));
  return delta;
};

export const reconcile = (input: {
  message: CarfMessage;
  user: CarfUser;
  own: OwnFigures;
  baseCurrency: string;
  fileHash: string;
  sources: { id: string; label: string }[];
}): CarfReconciliation => {
  const { message, user, own, baseCurrency } = input;
  const notReported = message.messageTypeIndic === 'CARF703';

  // assetId → names reported under, and blocks per category.
  const reportedAssets = new Map<
    string,
    { names: string[]; blocks: Map<CarfCategory, CarfBlock[]> }
  >();
  const unrecognised: CarfAssetReport[] = [];
  for (const asset of user.assets) {
    const entry = resolveCarfAsset(asset.name);
    if (!entry) {
      unrecognised.push(asset);
      continue;
    }
    const slot = reportedAssets.get(entry.id) ?? {
      names: [] as string[],
      blocks: new Map<CarfCategory, CarfBlock[]>(),
    };
    reportedAssets.set(entry.id, slot);
    slot.names.push(asset.name);
    for (const b of asset.blocks) {
      const list = slot.blocks.get(b.category) ?? [];
      list.push(b);
      slot.blocks.set(b.category, list);
    }
  }

  const keys = new Map<string, { assetId: string; category: CarfCategory }>();
  for (const [assetId, slot] of reportedAssets) {
    for (const category of slot.blocks.keys()) {
      keys.set(`${assetId}|${category}`, { assetId, category });
    }
  }
  for (const [assetId, categories] of Object.entries(own)) {
    for (const category of Object.keys(categories) as CarfCategory[]) {
      keys.set(`${assetId}|${category}`, { assetId, category });
    }
  }

  const rows: ReconciliationRow[] = [...keys.values()].map(
    ({ assetId, category }) => {
      const slot = reportedAssets.get(assetId);
      const blocks = slot?.blocks.get(category);
      const reported = blocks ? sumReported(blocks) : undefined;
      const ownCategory = own[assetId]?.[category];
      const ownRow = ownCategory ? ownSide(ownCategory, assetId) : undefined;
      const verdict = verdictOf(
        category,
        reported,
        ownRow,
        notReported,
        baseCurrency,
      );
      const delta = deltaOf(reported, ownRow);
      if (
        reported &&
        ownRow &&
        ownRow.amount !== undefined &&
        reported.currency &&
        reported.currency.toLowerCase() === baseCurrency.toLowerCase()
      ) {
        delta.amount = plain(new Big(ownRow.amount).minus(reported.amount));
      }
      const several = slot && slot.names.length > 1 && blocks;
      return {
        assetId,
        symbol: symbolOf(assetId),
        category,
        ...(reported ? { reported } : {}),
        ...(ownRow ? { own: ownRow } : {}),
        delta,
        verdict,
        ...(several
          ? {
              note: 'Reported under several names: {{names}}',
              noteParams: { names: slot.names.join(', ') },
            }
          : {}),
      };
    },
  );

  rows.sort(
    (a, b) =>
      a.symbol.toLowerCase().localeCompare(b.symbol.toLowerCase()) ||
      (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0) ||
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
  );

  const summary: CarfReconciliation['summary'] = {
    match: 0,
    differs: 0,
    'missing-own': 0,
    'not-reported': 0,
    unpriced: 0,
    'not-compared': 0,
    'not-recognised': unrecognised.length,
  };
  for (const row of rows) summary[row.verdict] += 1;

  return {
    messageRefId: message.messageRefId,
    messageTypeIndic: message.messageTypeIndic,
    reportingPeriod: message.reportingPeriod,
    year: message.year,
    timestamp: message.timestamp,
    provider: message.provider.name,
    user: {
      name: user.name,
      tins: user.tins,
      docRefId: user.docRefId,
      docTypeIndic: user.docTypeIndic,
    },
    sourceIds: input.sources.map((s) => s.id),
    sourceLabels: input.sources.map((s) => s.label),
    fileHash: input.fileHash,
    baseCurrency,
    rows,
    unrecognised,
    summary,
  };
};

/** Spreadsheet-formula guard and RFC 4180 quoting, as in `registerToCsv`. */
const cell = (value: string | number | undefined): string => {
  const raw = value === undefined ? '' : String(value);
  const text =
    /^[=+\-@\t\r]/.test(raw) && !/^-?\d+(\.\d+)?$/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const HEADER = [
  'asset',
  'category',
  'verdict',
  'reportedTransactions',
  'reportedUnits',
  'reportedAmount',
  'reportedCurrency',
  'ownTransactions',
  'ownUnits',
  'ownAmount',
  'ownFees',
  'deltaTransactions',
  'deltaUnits',
  'deltaAmount',
  'provider',
  'messageRefId',
  'reportingPeriod',
  'fileHash',
];

export const reconciliationToCsv = (r: CarfReconciliation): string => {
  const tail = [r.provider, r.messageRefId, r.reportingPeriod, r.fileHash];
  const line = (cells: (string | number | undefined)[]): string =>
    [
      ...cells,
      ...Array<undefined>(HEADER.length - tail.length - cells.length),
      ...tail,
    ]
      .map(cell)
      .join(',');
  const lines = [
    HEADER.join(','),
    ...r.rows.map((row) =>
      line([
        row.symbol,
        row.category,
        row.verdict,
        row.reported?.transactions,
        row.reported?.units,
        row.reported?.amount,
        row.reported?.currency,
        row.own?.transactions,
        row.own?.units,
        row.own?.amount,
        row.own?.fees,
        row.delta.transactions,
        row.delta.units,
        row.delta.amount,
      ]),
    ),
    ...r.unrecognised.flatMap((asset) =>
      asset.blocks.map((b) =>
        line([
          asset.name,
          b.category,
          'not-recognised',
          b.transactions,
          b.units,
          b.amount,
          b.currency,
        ]),
      ),
    ),
  ];
  return `${lines.join('\r\n')}\r\n`;
};
