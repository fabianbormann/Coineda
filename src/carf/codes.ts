/**
 * CARF code lists (OECD CARF XML schema v1.5). The labels are English
 * translation keys; a code without a label falls back to the code itself.
 */

export const MESSAGE_TYPES: Record<string, string> = {
  CARF701: 'New data',
  CARF702: 'Corrections',
  CARF703: 'Nothing to report',
};

/** `ExchangeType` of a crypto-to-crypto block. */
export const EXCHANGE_TYPES: Record<string, string> = {
  CARF401: 'Staking',
  CARF402: 'Crypto loan',
  CARF403: 'Wrapping',
  CARF404: 'Collateral',
};

/** `TransferType` of a `CryptoTransferIn` block. */
export const TRANSFER_IN_TYPES: Record<string, string> = {
  CARF501: 'Airdrop',
  CARF502: 'Staking income',
  CARF503: 'Mining income',
  CARF504: 'Crypto loan',
  CARF505: 'Transfer from another RCASP',
  CARF506: 'Sale of goods or services',
  CARF507: 'Collateral',
  CARF508: 'Other',
  CARF509: 'Unknown',
};

/** `TransferType` of a `CryptoTransferOut` block. */
export const TRANSFER_OUT_TYPES: Record<string, string> = {
  CARF601: 'Transfer to another RCASP',
  CARF602: 'Crypto loan',
  CARF603: 'Purchase of goods or services',
  CARF604: 'Collateral',
  CARF605: 'Other',
  CARF606: 'Unknown',
};

/** `DocTypeIndic` of a `DocSpec`. */
export const DOC_TYPES: Record<string, string> = {
  OECD0: 'Resent',
  OECD1: 'New',
  OECD2: 'Corrected',
  OECD3: 'Deleted',
  OECD10: 'Test',
  OECD11: 'Test',
  OECD12: 'Test',
  OECD13: 'Test',
};

const ALL_CODES: Record<string, string> = {
  ...MESSAGE_TYPES,
  ...EXCHANGE_TYPES,
  ...TRANSFER_IN_TYPES,
  ...TRANSFER_OUT_TYPES,
  ...DOC_TYPES,
};

/** The translation key for a CARF code, or the code itself if unknown. */
export const labelOfCode = (code: string): string =>
  Object.prototype.hasOwnProperty.call(ALL_CODES, code)
    ? ALL_CODES[code]
    : code;
