/**
 * Turns a provider amount into a decimal string, refusing one that JSON
 * parsing has already destroyed.
 *
 * Shared across chains because the failure mode is not Cardano-specific: any
 * provider that sends an amount as a JSON number rather than a string risks
 * it, since `JSON.parse` has already rounded anything above
 * `Number.MAX_SAFE_INTEGER` by the time this code runs - the true value is
 * simply gone and no amount of care here can recover it. Failing the sync is
 * the only honest response, because the alternative is a silently wrong
 * number in a tax report.
 *
 * Originally lived in src/sources/cardano/utxo.ts with the chain name
 * hardcoded into the thrown message. Moved here, taking `chain` as a
 * parameter, so a second chain (Bitcoin's Esplora module, whose Esplora
 * `value` field is a JSON number in satoshis) gets the same guard without a
 * second hand-written copy of it. src/sources/cardano/utxo.ts re-exports a
 * wrapper bound to `'cardano'`, so every Cardano call site and every Cardano
 * message - including the two tests that assert on it verbatim
 * (tests/cardanoRewardPot.test.ts, tests/cardanoBlockfrostFixtures.test.ts) -
 * stays byte-identical.
 */
export const amountString = (
  value: number | string,
  what: string,
  chain: string,
): string => {
  if (typeof value === 'string') {
    return value;
  }
  // Absent or non-numeric is a DIFFERENT failure from a rounded one, and it
  // gets its own message. Both are typed `number` at the call sites - the
  // Esplora translator casts `vin[].prevout.value`, which the provider's
  // shape makes optional - so an undefined slipping through used to land on
  // the precision message below, via Number.isSafeInteger(undefined) being
  // false. That message claims JSON.parse rounded a value away, which would
  // be actively misleading here: nothing was rounded, the field was never
  // sent. Whatever this throws is stored verbatim as the source's lastError
  // and rendered on screen, so a wrong diagnosis costs someone an evening
  // chasing a precision bug that does not exist.
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(
      `${chain}: ${what} is missing from the provider's response, so it cannot be recorded`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `${chain}: ${what} exceeds safe integer precision - JSON parsing has already rounded it, so the true value cannot be recovered`,
    );
  }
  return String(value);
};
