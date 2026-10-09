export type LegDirection = 'in' | 'out';
export type LegRole = 'principal' | 'fee';

export type Leg = {
  /** Chain-qualified so the same symbol on two chains is two assets:
   *  'cardano:lovelace', 'eth:0xa0b86991c…'. */
  assetId: string;
  /** Decimal string. Never a JS number. See src/ledger/amount.ts. */
  amount: string;
  direction: LegDirection;
  /** Which wallet or exchange the value moved through. */
  venue: string;
  role: LegRole;
};

export type EventKind =
  | 'trade'
  | 'transfer'
  | 'reward'
  | 'fee'
  | 'fiat-in'
  | 'fiat-out'
  | 'derivative';

/** What a derivative settlement was: realised profit or loss, a funding
 *  payment, a margin rollover fee, or a futures commission. */
export type DerivativeKind = 'pnl' | 'funding' | 'rollover' | 'commission';

/**
 * What a `reward` event is, as the source knows it.
 *
 * Typed, because a tax rule branches on it: staking and lending are §22
 * Nr. 3 income in Germany, a pool operator's leader reward may be business
 * income, an airdrop and a hard fork each have their own treatment. Before
 * this field, Germany recognised staking by a regular expression over the
 * prose `note` and every other reward fell through as "unclassified".
 */
export type RewardKind =
  | 'staking'
  | 'leader'
  | 'lending'
  | 'liquidity'
  | 'mining'
  | 'masternode'
  | 'airdrop'
  | 'fork'
  | 'other';

export type LedgerEvent = {
  id: string;
  /** The configured source that produced this. */
  sourceId: string;
  /** Stable id from that source: a tx hash plus output index, a trade id.
   *  Together with sourceId this is the event's identity. */
  externalId: string;
  /** Epoch milliseconds, UTC. Displayed through one local formatter. */
  timestamp: number;
  kind: EventKind;
  legs: Leg[];
  /** On `kind: 'reward'` events: what kind of reward, set by the source.
   *  Absent on rows written before the field existed, which the
   *  jurisdictions still read through their legacy heuristics. */
  rewardKind?: RewardKind;
  /** On `kind: 'derivative'` events: what the settlement was. `instrument`
   *  is provenance only (a pair or symbol the row named), never parsed. */
  derivative?: { kind: DerivativeKind; instrument?: string };
  /** 'derived' rows are discarded and refetched on a re-sync; 'authored'
   *  rows are the user's own and travel in the checkpoint. */
  origin: 'derived' | 'authored';
  /**
   * The on-chain transaction this movement happened in, when the source
   * knows it.
   *
   * A TYPED field rather than something read back out of `note` or parsed
   * off `externalId`. Both of those are prose or an opaque id, and this is
   * data a calculation branches on: it is the only exact way to recognise
   * that an exchange's withdrawal and a wallet's receipt are two sides of
   * ONE movement rather than a sale followed by a purchase. See
   * src/ledger/transfers.ts.
   *
   * Set by a chain module to the transaction's own hash, and by an exchange
   * module to the hash it reports for a withdrawal or deposit. Absent where
   * a source does not know one, which is most exchange-internal activity.
   */
  txHash?: string;
  /** The source's own payload, kept so an event can be re-derived or
   *  debugged without another network round trip. */
  raw?: unknown;
  /**
   * Human-readable provenance: why this event exists, in words, for an
   * audit trail a user or their accountant can follow back from a tax
   * report to the thing that produced it.
   *
   * Display and explanation only - never parsed, and never the carrier of
   * data a calculation depends on. Anything a tax rule must branch on
   * belongs in a typed field, because a rule matching on prose is a rule
   * that breaks when the prose is reworded or translated.
   */
  note?: string;
};

/** Opaque to the host: only the module that issued it may interpret it. */
export type Cursor = string | null;

export type SourceRecord = {
  id: string;
  moduleId: string;
  label: string;
  /** May contain secrets, so this is never logged and never leaves the
   *  device unencrypted. */
  config: Record<string, string>;
  lastSyncedAt?: number;
  lastError?: string;
};
