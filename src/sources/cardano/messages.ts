/**
 * The messages a Cardano probe can return.
 *
 * In one place so tests/cardanoProbeMessages.test.ts can iterate them
 * against both locale files. They were spread across two modules before,
 * and two of them were in neither locale file - a German user got English,
 * and no gate noticed, because registry.test.ts checks field labels and
 * help text but not the messages a probe returns.
 *
 * Each value IS the translation key: this project keys on the English
 * string (see src/i18n.js). None of them may name anything from `config` -
 * see the error-message rule on SourceModule.
 */
export const CARDANO_MESSAGES = {
  addressNeverSeen:
    'This provider has no record of that address, so it has never appeared on chain. Paste the wallet’s stake address instead - that works even for a brand-new address.',
  instanceCannotServe:
    'This instance answered, but it cannot list this wallet’s transactions. Point the base URL at an instance with the Blockfrost-compatible API enabled, or use a provider that has it.',
  stakeAddressNeedsAccountApi:
    'That looks like a stake address, and this instance cannot look up an account. Enter one of the wallet’s payment addresses instead.',
  hostShape:
    'The base URL should be the host only, without an API path - for example {{example}}.',
} as const;
