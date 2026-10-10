import { parseAddressList } from './addressList';

/**
 * The addresses a chain source tracks, read from its stored config.
 *
 * The Ethereum and Cardano modules used to take ONE address, under the
 * config key `address`; they now take a list under `addressList`, one per
 * line, as Bitcoin Esplora does. A source saved before the switch still has
 * only `address`, and reading it as a one-element list here - on every read,
 * rather than by rewriting storage - is the migration: nothing is lost, and
 * the first save through EditSourceDialog writes `addressList` and drops the
 * old key (see `migrateAddressConfig`).
 *
 * `addressList` wins whenever the key is present at all, even blank: a list
 * the user emptied is an empty list, not a cue to resurrect a stale
 * `address`.
 */
export const readAddresses = (config: Record<string, string>): string[] => {
  if (config.addressList !== undefined) {
    return parseAddressList(config.addressList);
  }
  const single = (config.address ?? '').trim();
  return single === '' ? [] : [single];
};

/** The manifest field name the address-list modules declare. */
export const ADDRESS_LIST_FIELD = 'addressList';

/**
 * A stored config in the current shape: `addressList` filled from
 * `readAddresses`, and the legacy `address` key removed.
 *
 * Only for a module that declares an `addressList` field - Esplora keeps
 * its list under `address` and is left exactly as it is.
 */
export const migrateAddressConfig = (
  fieldNames: string[],
  config: Record<string, string>,
): Record<string, string> => {
  if (!fieldNames.includes(ADDRESS_LIST_FIELD)) {
    return config;
  }
  const rest = { ...config };
  delete rest.address;
  return {
    ...rest,
    [ADDRESS_LIST_FIELD]:
      config.addressList ?? readAddresses(config).join('\n'),
  };
};

/**
 * A note a module attaches to a page: something the user should know that
 * is not a failure. `message` is a translation key, like a probe message,
 * and - by the same contract - never carries anything from `config`; an
 * address is named by its line in the list instead.
 */
export const ADDRESS_NO_TRANSACTIONS_YET =
  'Address {{line}} in the list has no transactions yet.';

/** The same key Bitcoin Esplora refuses an over-long list with. */
export const TOO_MANY_ADDRESSES =
  'You can track at most {{max}} addresses - remove some before saving.';
