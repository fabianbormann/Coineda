import Big from 'big.js';
import type { LedgerEvent } from '@/ledger/types';
import { symbolOf, toWholeUnits } from '@/components/money/asset';
import {
  PAID_ORIGIN_KEY,
  RESIDUAL_ORIGIN_KEY,
  residualOriginKey,
} from './residualOrigin';
import type { RegisterRow, TaxEvent, TaxReport, UnresolvedItem } from './types';

export { PAID_ORIGIN_KEY, RESIDUAL_ORIGIN_KEY };

const INTERNAL_TRANSFER_NOTE = 'Moved between your own wallets, not a sale.';

const iso = (timestamp: number): string => new Date(timestamp).toISOString();

/** A plain comparison: the same ledger must order the same everywhere. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The sum of the costs the host managed to value; absent when none were. */
const costsOf = (event: TaxEvent): string | undefined => {
  const valued = (event.costs ?? []).filter((cost) => cost.value !== undefined);
  if (valued.length === 0) {
    return undefined;
  }
  return valued
    .reduce((sum, cost) => sum.plus(new Big(cost.value ?? '0')), new Big(0))
    .toString();
};

const baseRow = (
  timestamp: number,
  sourceEventId: string,
  assetId: string,
  amount: string,
  venue: string,
) => ({
  date: iso(timestamp),
  sourceEventId,
  assetId,
  symbol: symbolOf(assetId),
  amount,
  amountWhole: toWholeUnits(amount, assetId),
  venue,
});

/**
 * One row per event the host dropped as a transfer between the user's own
 * venues, on the SENDING side. The receiving half of a linked pair is
 * skipped when its sender is also dropped, so one movement is one row.
 */
const internalTransferRows = (events: LedgerEvent[]): RegisterRow[] => {
  const sends = (event: LedgerEvent) =>
    event.legs.some((leg) => leg.direction === 'out');
  const senderHashes = new Set(
    events
      .filter((event) => sends(event) && event.txHash !== undefined)
      .map((event) => event.txHash),
  );
  const rows: RegisterRow[] = [];
  for (const event of events) {
    if (
      !sends(event) &&
      event.txHash !== undefined &&
      senderHashes.has(event.txHash)
    ) {
      continue;
    }
    const out =
      event.legs.find(
        (leg) => leg.direction === 'out' && leg.role === 'principal',
      ) ??
      event.legs.find((leg) => leg.direction === 'out') ??
      event.legs[0];
    if (out === undefined) {
      continue;
    }
    // Where it went: an in-leg of the same asset in this event, or in the
    // other half of the pair that shares its transaction hash.
    const receivers =
      event.txHash === undefined
        ? [event]
        : [
            event,
            ...events.filter(
              (other) => other !== event && other.txHash === event.txHash,
            ),
          ];
    const arrival = receivers
      .flatMap((candidate) => candidate.legs)
      .find(
        (leg) =>
          leg.direction === 'in' &&
          leg.assetId === out.assetId &&
          leg.venue !== out.venue,
      );
    rows.push({
      ...baseRow(event.timestamp, event.id, out.assetId, out.amount, out.venue),
      kind: 'internal-transfer',
      ...(event.txHash === undefined ? {} : { txHash: event.txHash }),
      ...(arrival === undefined ? {} : { counterVenue: arrival.venue }),
      note: INTERNAL_TRANSFER_NOTE,
    });
  }
  return rows;
};

export const buildRegister = (input: {
  year: number;
  valued: TaxEvent[];
  internalTransfers: LedgerEvent[];
  residuals: LedgerEvent[];
  unresolved: UnresolvedItem[];
  /** Ledger events by id, for the transaction hash behind a row. */
  eventById?: Map<string, LedgerEvent>;
}): RegisterRow[] => {
  const residualIds = new Set(input.residuals.map((event) => event.id));
  const hashOf = (id: string): string | undefined =>
    input.eventById?.get(id)?.txHash ??
    input.residuals.find((event) => event.id === id)?.txHash;

  const rows: RegisterRow[] = [];

  for (const event of input.valued) {
    if (new Date(event.timestamp).getUTCFullYear() !== input.year) {
      continue;
    }
    const txHash = hashOf(event.sourceEventId);
    const costs = costsOf(event);
    const note =
      event.note ??
      (residualIds.has(event.sourceEventId)
        ? residualOriginKey(event.sourceEventId)
        : undefined);
    rows.push({
      ...baseRow(
        event.timestamp,
        event.sourceEventId,
        event.assetId,
        event.amount,
        event.venue,
      ),
      kind: event.kind,
      ...(txHash === undefined ? {} : { txHash }),
      ...(event.value === undefined ? {} : { value: event.value }),
      ...(event.priceSource === undefined
        ? {}
        : { priceSource: event.priceSource }),
      ...(event.consideration === undefined
        ? {}
        : {
            considerationAssetId: event.consideration.assetId,
            considerationAmount: event.consideration.amount,
          }),
      ...(costs === undefined ? {} : { costs }),
      ...(note === undefined ? {} : { note }),
    });
  }

  rows.push(
    ...internalTransferRows(
      input.internalTransfers.filter(
        (event) => new Date(event.timestamp).getUTCFullYear() === input.year,
      ),
    ),
  );

  for (const item of input.unresolved) {
    if (new Date(item.timestamp).getUTCFullYear() !== input.year) {
      continue;
    }
    rows.push({
      ...baseRow(
        item.timestamp,
        item.sourceEventId,
        item.assetId,
        item.amount,
        item.venue,
      ),
      kind: 'unpriced',
      ...(item.txHash === undefined ? {} : { txHash: item.txHash }),
      note: item.reason.key,
    });
  }

  return rows.sort(
    (a, b) =>
      compare(a.date, b.date) ||
      compare(a.sourceEventId, b.sourceEventId) ||
      compare(a.kind, b.kind),
  );
};

const COLUMNS: { key: keyof RegisterRow; header: string }[] = [
  { key: 'date', header: 'date' },
  { key: 'kind', header: 'kind' },
  { key: 'sourceEventId', header: 'sourceEventId' },
  { key: 'txHash', header: 'txHash' },
  { key: 'assetId', header: 'assetId' },
  { key: 'symbol', header: 'symbol' },
  { key: 'amount', header: 'amount' },
  { key: 'amountWhole', header: 'amountWhole' },
  { key: 'venue', header: 'venue' },
  { key: 'counterVenue', header: 'counterVenue' },
  { key: 'value', header: 'value' },
  { key: 'priceSource', header: 'priceSource' },
  { key: 'considerationAssetId', header: 'considerationAssetId' },
  { key: 'considerationAmount', header: 'considerationAmount' },
  { key: 'costs', header: 'costs' },
  { key: 'note', header: 'note' },
];

/** RFC 4180: a cell with a comma, quote or line break is quoted, quotes doubled. */
const cell = (value: string | undefined): string => {
  const text = value ?? '';
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const BOM = String.fromCharCode(0xfeff);

/** UTF-8 BOM (so a spreadsheet opens it as UTF-8), header, then one line per row. */
export const registerToCsv = (rows: RegisterRow[]): string => {
  const lines = [
    COLUMNS.map((column) => column.header).join(','),
    ...rows.map((row) =>
      COLUMNS.map((column) => cell(row[column.key])).join(','),
    ),
  ];
  return `${BOM}${lines.join('\r\n')}\r\n`;
};

export const reportToJson = (report: TaxReport): string =>
  JSON.stringify(
    {
      format: 'coineda-tax-report',
      formatVersion: 1,
      fingerprint: report.method.fingerprint,
      method: report.method,
      totals: report.totals,
      thresholds: report.thresholds,
      lines: report.lines,
      income: report.income,
      capital: report.capital,
      capitalResult: report.capitalResult ?? null,
      register: report.register,
    },
    null,
    2,
  );

export const registerFilename = (
  year: number,
  fingerprint: string,
  ext: 'csv' | 'json',
): string => `coineda-register-${year}-${fingerprint.slice(0, 12)}.${ext}`;
