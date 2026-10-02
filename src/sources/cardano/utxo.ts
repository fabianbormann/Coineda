export type UtxoAmount = {
  unit: string;
  /** Already a decimal string - never parse this to a number and back. */
  quantity: string;
};

export type UtxoEntry = {
  address: string;
  /**
   * The account this payment address belongs to, or null for an enterprise
   * or Byron-era address that has no staking part.
   *
   * YACI ONLY. Blockfrost does not send this field at all - measured
   * across the 16 live mainnet transactions in
   * src/sources/cardano-blockfrost/fixtures, and asserted by
   * tests/cardanoBlockfrostFixtures.test.ts rather than left as prose. Its
   * input and output entries carry slightly different key sets (only
   * outputs have `consumed_by_tx`, only inputs have `reference`); neither
   * carries `stake_address`. See the key lists in
   * src/sources/cardano-blockfrost/index.ts.
   * So `accountOf` always returns null on Blockfrost and the Tier 2 path
   * silently falls back to exact payment-address matching. Tier 1 does not
   * read this field; it recognises the account's entries by the account's
   * enumerated address set instead. See src/sources/cardano/account.ts.
   */
  stake_address?: string | null;
  /**
   * True when this entry is COLLATERAL rather than a real movement.
   *
   * A successful script transaction lists its collateral and never spends
   * it. Blockfrost flags it here; Yaci's TxUtxo schema has no such field, so
   * a native Yaci source cannot distinguish collateral at all and keeps the
   * old behaviour - a documented provider gap, not an oversight.
   */
  collateral?: boolean;
  /**
   * True when this entry is a REFERENCE input rather than a real movement.
   *
   * A reference input is read, never consumed: a dApp points at a UTxO to
   * see its datum and the UTxO survives the transaction untouched. Counting
   * it as a spend is the collateral bug in a different costume - a phantom
   * disposal and a negative balance - and it is reachable whenever a script
   * references one of this wallet's own UTxOs.
   *
   * Blockfrost flags it per input entry: all 30 recorded input entries in
   * src/sources/cardano-blockfrost/fixtures carry `"reference": false`, so
   * the field is live there and simply never true in that recording. Yaci's
   * TxUtxo schema has no such field, the same documented provider gap
   * `collateral` has.
   */
  reference?: boolean;
  amount: UtxoAmount[];
};

export type TxUtxos = {
  inputs: UtxoEntry[];
  outputs: UtxoEntry[];
};

/** Chain-qualified so 'lovelace' here can never collide with the same
 *  symbol on another chain, and the native lovelace unit gets its own
 *  readable id instead of inheriting the raw provider unit string. */
export const assetIdOf = (unit: string): string =>
  unit === 'lovelace' ? 'cardano:lovelace' : `cardano:${unit}`;

/**
 * Turns a provider amount into a decimal string, refusing one that JSON
 * parsing has already destroyed.
 *
 * The utxo endpoints return `quantity` as a string, which passes through
 * untouched. The rewards endpoint is where the providers disagree: Yaci
 * returns `amount` as a JSON number and Blockfrost as a string, both
 * recorded. Where it arrives as a number, `JSON.parse` has already rounded
 * anything above Number.MAX_SAFE_INTEGER by the time this function runs -
 * the true value is simply gone and no amount of care here can recover it. Failing the sync is the only honest
 * response, because the alternative is a silently wrong number in a tax
 * report.
 */
export const amountString = (value: number | string, what: string): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `cardano: ${what} exceeds safe integer precision - JSON parsing has already rounded it, so the true value cannot be recovered`,
    );
  }
  return String(value);
};
