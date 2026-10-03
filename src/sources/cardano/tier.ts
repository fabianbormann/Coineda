import type { CardanoProvider } from './provider';
import { probeRoute } from './http';
import { CARDANO_MESSAGES } from './messages';
import { ADDRESS_PAGE_SIZE, PAGE_SIZE } from './cursor';
import { stakeAddressOf } from './shelley';

/**
 * A Cardano wallet is an account - one stake address - spread across many
 * rotating payment addresses. Tracking a single payment address means
 * change returning to a DIFFERENT address of the same wallet is invisible,
 * so an ordinary outbound payment looks like a disposal of everything that
 * left.
 */
export const STAKE_PREFIXES = ['stake1', 'stake_test1'];

export const isStakeAddress = (address: string): boolean =>
  STAKE_PREFIXES.some((prefix) => address?.startsWith(prefix));

/**
 * The configured address, normalised exactly once.
 *
 * Every path that builds a URL from it must use this. A pasted address
 * commonly arrives with a trailing space or newline - AddSourceDialog stores
 * the input verbatim - and when one path trimmed while another did not, the
 * probe validated `/addresses/addr1...` while the drain requested
 * `/addresses/addr1... /transactions` and failed with exactly the raw
 * "listing transactions failed with status 404" this module exists to retire.
 *
 * Case is folded for a BECH32 address and for nothing else.
 *
 * Bech32 permits an all-uppercase encoding and some wallets and QR codes
 * use it, while the canonical on-chain spelling is lowercase and
 * `isStakeAddress` matches its prefixes case-sensitively - so without
 * folding, an uppercase STAKE1... was taken for a payment address and the
 * user was told to paste the stake address they had just pasted. Mixed case
 * is not valid bech32, so folding loses nothing there.
 *
 * A BYRON-ERA address is base58 and CASE-SENSITIVE, and this module supports
 * one as a configured address (see `resolveTarget`'s enterprise/Byron branch
 * and `legsFor`'s null-account fallback). Folding it destroyed it:
 * `DdzFFzCqrhsf1sVGPjhRTaMSFNEKbEzWRbEaAJfqBZPNQx…` became
 * `ddzffzcqrhsf1svgpjhrtamsfnekbezwrbeaajfqbzpnqx…`, the lookup missed, and
 * the user was advised to paste a stake address a Byron address does not
 * have. Worse, had a listing answered, `legsFor` compares
 * `entry.address === address` against the provider's correctly-cased value,
 * matched nothing, skipped every transaction for having no legs and reported
 * ZERO EVENTS WITH NO ERROR - and because this normalises at read time, an
 * already-working source would have broken on upgrade with no user action.
 *
 * Hence the prefix test rather than an unconditional fold: anything that is
 * not recognisably bech32 is passed through exactly as given.
 */
const BECH32_ADDRESS = /^(addr|addr_test|stake|stake_test)1/i;

export const configuredAddress = (config: Record<string, string>): string => {
  const trimmed = (config.address ?? '').trim();
  return BECH32_ADDRESS.test(trimmed) ? trimmed.toLowerCase() : trimmed;
};

/**
 * What this source should drain, and how.
 *
 * - `account`: the instance serves the account routes, so one listing
 *   sequence covers the whole wallet. Complete history, and staking income
 *   without needing any transaction to exist first.
 * - `address`: today's behaviour, one payment address, unchanged.
 * - `refused`: the instance cannot serve this source at all. Returned
 *   rather than thrown, because `probe` has to render it and `fetchEvents`
 *   has to fail with it, and both need the same answer.
 */
export type Target =
  | { tier: 'account'; account: string }
  | { tier: 'address' }
  | {
      tier: 'refused';
      message: string;
      messageParams?: Record<string, string>;
    };

/**
 * Whether this instance serves BOTH account routes the account tier needs.
 *
 * Two requests, not one. The transactions route supplies the history and
 * the addresses route is how the account's own utxo entries are recognised
 * at all - Blockfrost omits `stake_address` from `/txs/{hash}/utxos`
 * entirely, so an instance that could list transactions but not addresses
 * would build legs from the wrong entries rather than fail. Verified:
 * Blockfrost answers both in ~0.1s; the public Yaci instances serve
 * neither.
 *
 * Both URLs are the drain's OWN first-page requests, page sizes included,
 * rather than a cheaper `count=1` variant. Probing a different request than
 * the sync makes is a weaker check - a provider may page one way and not
 * the other - and this way every probed URL is one the drain also issues,
 * so one recorded response serves both.
 */
type AccountTierResult =
  | { tier: 'available' }
  | { tier: 'absent' }
  | { tier: 'timeout' }
  | { tier: 'status'; status: number };

const accountTier = async (
  root: string,
  headers: Record<string, string>,
  account: string,
  signal?: AbortSignal,
): Promise<AccountTierResult> => {
  for (const url of [
    `${root}/accounts/${account}/transactions?page=1&count=${PAGE_SIZE}&order=asc`,
    `${root}/accounts/${account}/addresses?page=1&count=${ADDRESS_PAGE_SIZE}`,
  ]) {
    const result = await probeRoute(url, headers, signal);
    if (result.outcome === 'timeout') {
      return { tier: 'timeout' };
    }
    if (result.outcome === 'unreachable') {
      // A route we could not reach at all is no evidence that a DIFFERENT
      // route works - the same rule the timeout branch follows. Reported as
      // status 0, which is what probeMessage already means by "unreachable".
      return { tier: 'status', status: 0 };
    }
    if (result.outcome === 'status') {
      // ONLY 404 means "this instance does not serve account tracking". Any
      // other status is the provider saying something specific - a refused
      // credential, a rate limit - and it has to keep saying it. Collapsing
      // them told a user with a wrong project id to enter a payment address
      // instead, which is advice to change a setting that was never wrong.
      return result.status === 404
        ? { tier: 'absent' }
        : { tier: 'status', status: result.status };
    }
  }
  return { tier: 'available' };
};

/**
 * Resolves the configured value to an account, and picks the tier.
 *
 * These are one decision, not two, because a payment address cannot be
 * turned into an account without a route whose ABSENCE looks exactly like
 * an unseen address. Native Yaci serves
 * `/addresses/{address}/transactions` but has no plain
 * `/addresses/{address}` - so a 404 there means "route absent" on Yaci and
 * "never seen on chain" on Blockfrost, and reading it wrong tells a
 * healthy Yaci user their address does not exist.
 *
 * The procedure therefore disambiguates by BEHAVIOUR - whether the route
 * the address tier actually uses answers - and never by parsing an error
 * body. Yaci reports its own 404 with a `No endpoint GET …` payload and
 * Blockfrost with its own JSON; branching on either is the fragility
 * `probeMessage(status)` exists to avoid.
 *
 * `root` is passed in rather than computed here so `fetchEvents` can let a
 * malformed host THROW (it belongs in `lastError` verbatim) while `probe`
 * catches it and renders a translated message.
 */
export const resolveTarget = async (
  provider: CardanoProvider,
  config: Record<string, string>,
  root: string,
  signal?: AbortSignal,
): Promise<Target> => {
  const headers = provider.headers(config);
  const configured = configuredAddress(config);

  if (isStakeAddress(configured)) {
    const tier = await accountTier(root, headers, configured, signal);
    if (tier.tier === 'available') {
      return { tier: 'account', account: configured };
    }
    if (tier.tier === 'timeout') {
      return {
        tier: 'refused',
        message: CARDANO_MESSAGES.instanceCannotServe,
      };
    }
    if (tier.tier === 'status') {
      return { tier: 'refused', message: provider.probeMessage(tier.status) };
    }
    // A stake address cannot work on the address tier: Yaci answers 200
    // with an empty array for one, which would be a SUCCESSFUL sync
    // reporting zero transactions and nothing saying the input was the
    // wrong kind of address.
    return {
      tier: 'refused',
      message: CARDANO_MESSAGES.stakeAddressNeedsAccountApi,
    };
  }

  // The staking credential is IN the address, so read it before asking the
  // provider for it.
  //
  // This is not an optimisation, it is the fix for a reported failure. The
  // lookup below resolves the account from `/addresses/{address}`, which
  // Blockfrost answers 404 for an address that has never appeared on chain -
  // so the account tier was unreachable for exactly the address a user is
  // most likely to paste, the fresh receive address their wallet shows them,
  // and the result was a 404 with nothing explaining it. A base address
  // carries its staking credential in bytes 29..57 whatever its history, so
  // an unused address now resolves as well as a busy one, and with one fewer
  // request.
  //
  // Only a successful account tier short-circuits. Anything else falls
  // through to the provider path below rather than returning the address
  // tier directly, because that path is what validates the drain's OWN
  // route - skipping it would let a probe pass on an instance the sync then
  // fails against, which is the exact gap this probe was rewritten to close.
  // That costs one extra request on an instance with no account routes, at
  // probe time only, which is worth paying to keep the validation.
  const derived = stakeAddressOf(configured);
  if (derived !== null) {
    const tier = await accountTier(root, headers, derived, signal);
    if (tier.tier === 'timeout') {
      return { tier: 'refused', message: CARDANO_MESSAGES.instanceCannotServe };
    }
    if (tier.tier === 'status') {
      return { tier: 'refused', message: provider.probeMessage(tier.status) };
    }
    if (tier.tier === 'available') {
      return { tier: 'account', account: derived };
    }
  }

  const lookup = await probeRoute(
    `${root}/addresses/${configured}`,
    headers,
    signal,
  );

  if (lookup.outcome === 'timeout') {
    return { tier: 'refused', message: CARDANO_MESSAGES.instanceCannotServe };
  }
  if (lookup.outcome === 'unreachable') {
    return { tier: 'refused', message: provider.probeMessage(0) };
  }
  if (lookup.outcome === 'ok') {
    const stake = (lookup.body as { stake_address?: string | null } | null)
      ?.stake_address;
    if (typeof stake !== 'string' || stake === '') {
      // An enterprise or Byron address has no staking part, so there is no
      // account to track. The address tier is the right answer, not an
      // error.
      return { tier: 'address' };
    }
    const tier = await accountTier(root, headers, stake, signal);
    if (tier.tier === 'timeout') {
      return {
        tier: 'refused',
        message: CARDANO_MESSAGES.instanceCannotServe,
      };
    }
    if (tier.tier === 'status') {
      // Refuse rather than quietly degrade to the address tier. Address-only
      // coverage is exactly what produces the wrong numbers this feature
      // exists to fix, so a visible, retryable error beats silent partial
      // data - and a rate limit is transient, so retrying is the right move.
      return { tier: 'refused', message: provider.probeMessage(tier.status) };
    }
    return tier.tier === 'available'
      ? { tier: 'account', account: stake }
      : { tier: 'address' };
  }

  // A status. Only 404 is ambiguous; anything else is the provider saying
  // something specific - a refused credential, a rate limit - and must keep
  // saying it. Dropping /blocks/latest from the probe would otherwise lose
  // the 401/403 handling that told a Blockfrost user their project id was
  // wrong.
  if (lookup.status !== 404) {
    return { tier: 'refused', message: provider.probeMessage(lookup.status) };
  }

  // The drain's own first-page URL, page size and order included - not a
  // cheaper `count=1` variant. Spec section 7 taken literally: the probe
  // has to exercise the exact request the sync will issue, so an instance
  // that answers one and not the other cannot pass the probe and then fail
  // the drain.
  const listing = await probeRoute(
    `${root}/addresses/${configured}/transactions?page=1&count=${PAGE_SIZE}&order=asc`,
    headers,
    signal,
  );
  if (listing.outcome === 'ok') {
    // The address-route family exists, so the 404 above meant the lookup
    // route is absent, not the address. This is the native-Yaci case.
    return { tier: 'address' };
  }
  if (listing.outcome === 'timeout') {
    return { tier: 'refused', message: CARDANO_MESSAGES.instanceCannotServe };
  }
  if (listing.outcome === 'unreachable') {
    return { tier: 'refused', message: provider.probeMessage(0) };
  }
  return listing.status === 404
    ? { tier: 'refused', message: CARDANO_MESSAGES.addressNeverSeen }
    : { tier: 'refused', message: provider.probeMessage(listing.status) };
};
