import type { EventKind } from '../../ledger/types';
import type { ParseResult } from '../csv/types';

export type CsvMapping = {
  version: 1;
  venueLabel: string;
  delimiter: 'auto' | ',' | ';' | '\t';
  columns: {
    date: string;
    asset: string;
    amount: string;
    type?: string;
    fee?: string;
    feeAsset?: string;
    counterAsset?: string;
    counterAmount?: string;
    price?: string; // price = counter per unit
    tradeId?: string;
    txHash?: string;
  };
  dateFormat: 'iso' | 'ymd' | 'dmy' | 'mdy' | 'unix-s' | 'unix-ms';
  timeZone: string; // 'UTC' or an IANA name; applied only when the value has no zone
  decimal: 'dot' | 'comma';
  direction: { mode: 'sign' } | { mode: 'type'; in: string[]; out: string[] };
  kinds: Record<string, EventKind>; // type value → kind; rows whose type is absent here are skipped by reason
  fiatCounter: boolean; // counterAsset/price is fiat → the trade gets a fiat consideration leg
};

/** Thrown by the mapped-CSV module's `parse`: it cannot parse without a
 *  user-supplied column mapping. */
export class MappingRequiredError extends Error {
  constructor(
    message = 'This CSV needs a column mapping before it can be imported.',
  ) {
    super(message);
    this.name = 'MappingRequiredError';
  }
}

export type MappedParseResult = ParseResult & {
  unresolved: string[];
  /** Translation keys: settings that parsed but look wrong. */
  warnings: string[];
};
