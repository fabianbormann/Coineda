import { addAmounts, sumAmounts } from '@/ledger/amount';
import { isFiatAsset } from '@/ledger/balances';
import type { LedgerEvent, Leg } from '@/ledger/types';
import { taxYearOf } from '@/tax/runTaxReport';
import type { CarfCategory } from './types';

/**
 * The client's own ledger, aggregated the way a CARF report aggregates: per
 * crypto-asset, per CARF block, an event count, the units moved and (where
 * the block is valued) the amount. Pure; the caller supplies the value
 * lookup built from the tax report's register rows.
 */

/** One figure set: event count, units in base units, amount in the base
 *  currency (undefined when any counted event had no value). */
export type OwnTyped = { transactions: number; units: string; amount?: string };

/** A category's totals across types, its fee legs in the category asset at
 *  the provider (base units), for the two fiat categories the fee legs in
 *  fiat (`fiatFees`), and for the transfer categories the split by CARF
 *  transfer type (`byType`, keyed by the CARF code). */
export type OwnCategory = OwnTyped & {
  fees: string;
  fiatFees?: string;
  byType: Record<string, OwnTyped>;
};

/** assetId → category → figures. */
export type OwnFigures = Record<
  string,
  Partial<Record<CarfCategory, OwnCategory>>
>;

export type AggregateOptions = {
  /** The reporting year, UTC. */
  year: number;
  /** The venues of the sources the report's provider stands for. */
  providerVenues: Set<string>;
  /** Every venue the client owns (carried for the caller; the categories
   *  below need only the provider and wallet venues). */
  ownedVenues: Set<string>;
  /** The owned venues of chain sources: the client's own wallets. */
  walletVenues: Set<string>;
  /** The value of an event's leg in an asset, in the base currency. */
  valueOf: (sourceEventId: string, assetId: string) => string | undefined;
};

/** CARF transfer types for rewards, by `rewardKind`; anything not listed is
 *  CARF508 (other). */
export const REWARD_TRANSFER_TYPE: Record<string, string> = {
  airdrop: 'CARF501',
  staking: 'CARF502',
  mining: 'CARF503',
  lending: 'CARF504',
  other: 'CARF508',
};

const rewardType = (kind: string | undefined): string =>
  REWARD_TRANSFER_TYPE[kind ?? 'other'] ?? 'CARF508';

/** An untyped transfer into the provider, and a transfer out of it. */
const TRANSFER_IN_UNTYPED = 'CARF509';
const TRANSFER_OUT_UNKNOWN = 'CARF606';

const isCrypto = (assetId: string): boolean => !isFiatAsset(assetId);

/** One event's contribution to one (asset, category); `amount: null` means
 *  the event has no value, which makes the category's amount unknown. */
type Entry = {
  units: string;
  amount: string | null;
  fees?: string;
  fiatFees?: string;
};

const addTyped = (target: OwnTyped, entry: Entry): void => {
  target.transactions += 1;
  target.units = addAmounts(target.units, entry.units);
  if (entry.amount === null || target.amount === undefined) {
    target.amount = undefined;
  } else {
    target.amount = addAmounts(target.amount, entry.amount);
  }
};

const emptyTyped = (): OwnTyped => ({
  transactions: 0,
  units: '0',
  amount: '0',
});

export const aggregateLedger = (
  events: LedgerEvent[],
  options: AggregateOptions,
): OwnFigures => {
  const figures: OwnFigures = {};
  const atProvider = (leg: Leg) => options.providerVenues.has(leg.venue);

  const book = (
    assetId: string,
    category: CarfCategory,
    entry: Entry,
    type?: string,
  ): void => {
    const perAsset = (figures[assetId] ??= {});
    const fiat = category === 'fiat-in' || category === 'fiat-out';
    const cat = (perAsset[category] ??= {
      ...emptyTyped(),
      fees: '0',
      ...(fiat ? { fiatFees: '0' } : {}),
      byType: {},
    });
    addTyped(cat, entry);
    if (entry.fees) cat.fees = addAmounts(cat.fees, entry.fees);
    if (fiat && entry.fiatFees) {
      cat.fiatFees = addAmounts(cat.fiatFees ?? '0', entry.fiatFees);
    }
    if (type) addTyped((cat.byType[type] ??= emptyTyped()), entry);
  };

  const value = (event: LedgerEvent, assetId: string): string | null =>
    options.valueOf(event.id, assetId) ?? null;

  for (const event of events) {
    if (taxYearOf(event.timestamp) !== options.year) continue;
    const here = event.legs.filter(atProvider);
    if (here.length === 0) continue;

    const principal = (direction: Leg['direction']) =>
      here.filter(
        (leg) => leg.role === 'principal' && leg.direction === direction,
      );
    const sumOf = (legs: Leg[], assetId: string) =>
      sumAmounts(
        legs.filter((leg) => leg.assetId === assetId).map((leg) => leg.amount),
      );
    const fees = here.filter((leg) => leg.role === 'fee');
    const feesIn = (assetId: string) => sumOf(fees, assetId);
    const fiatFees = () =>
      sumAmounts(
        fees.filter((leg) => isFiatAsset(leg.assetId)).map((l) => l.amount),
      );
    const assetsOf = (legs: Leg[]) => [
      ...new Set(legs.map((leg) => leg.assetId).filter(isCrypto)),
    ];

    const ins = principal('in');
    const outs = principal('out');

    if (event.kind === 'trade') {
      const cryptoIn = assetsOf(ins);
      const cryptoOut = assetsOf(outs);
      const fiatOut = outs.filter((leg) => isFiatAsset(leg.assetId));
      const fiatIn = ins.filter((leg) => isFiatAsset(leg.assetId));
      if (fiatOut.length > 0 && cryptoIn.length > 0) {
        const amount = sumAmounts(fiatOut.map((leg) => leg.amount));
        for (const assetId of cryptoIn) {
          book(assetId, 'fiat-in', {
            units: sumOf(ins, assetId),
            amount,
            fees: feesIn(assetId),
            fiatFees: fiatFees(),
          });
        }
      } else if (fiatIn.length > 0 && cryptoOut.length > 0) {
        const amount = sumAmounts(fiatIn.map((leg) => leg.amount));
        for (const assetId of cryptoOut) {
          book(assetId, 'fiat-out', {
            units: sumOf(outs, assetId),
            amount,
            fees: feesIn(assetId),
            fiatFees: fiatFees(),
          });
        }
      } else if (cryptoIn.length > 0 && cryptoOut.length > 0) {
        for (const assetId of cryptoIn) {
          book(assetId, 'crypto-in', {
            units: sumOf(ins, assetId),
            amount: value(event, assetId),
            fees: feesIn(assetId),
          });
        }
        for (const assetId of cryptoOut) {
          book(assetId, 'crypto-out', {
            units: sumOf(outs, assetId),
            amount: value(event, assetId),
            fees: feesIn(assetId),
          });
        }
      }
    } else if (event.kind === 'reward') {
      const type = rewardType(event.rewardKind);
      for (const assetId of assetsOf(ins)) {
        book(
          assetId,
          'transfer-in',
          {
            units: sumOf(ins, assetId),
            amount: value(event, assetId),
            fees: feesIn(assetId),
          },
          type,
        );
      }
    } else if (event.kind === 'transfer') {
      if (ins.length > 0 && outs.length === 0) {
        for (const assetId of assetsOf(ins)) {
          book(
            assetId,
            'transfer-in',
            {
              units: sumOf(ins, assetId),
              amount: value(event, assetId),
              fees: feesIn(assetId),
            },
            TRANSFER_IN_UNTYPED,
          );
        }
      } else if (outs.length > 0 && ins.length === 0) {
        const toWallet = event.legs.some(
          (leg) =>
            leg.direction === 'in' && options.walletVenues.has(leg.venue),
        );
        for (const assetId of assetsOf(outs)) {
          const entry: Entry = {
            units: sumOf(outs, assetId),
            amount: value(event, assetId),
            fees: feesIn(assetId),
          };
          book(assetId, 'transfer-out', entry, TRANSFER_OUT_UNKNOWN);
          if (toWallet) book(assetId, 'wallet', entry);
        }
      }
    }
  }

  return figures;
};
