/**
 * The parts of an OECD CARF XML message (schema v1.5, adopted verbatim by
 * the BZSt) that the reconciliation reads. Everything else in the file
 * (addresses, birth data, controlling persons) is deliberately not kept.
 */

/** One CARF block kind, named after the element it is read from. */
export type CarfCategory =
  | 'fiat-in' // CryptoFiatIn
  | 'fiat-out' // CryptoFiatOut
  | 'crypto-in' // CryptoToCryptoIn
  | 'crypto-out' // CryptoToCryptoOut
  | 'transfer-in' // CryptoTransferIn
  | 'transfer-out' // CryptoTransferOut
  | 'wallet' // TransferWallet
  | 'rrpt'; // RRPT (reportable retail payment transactions)

/**
 * One reported block. Amounts and units stay the decimal strings the
 * provider wrote; `transactions` is absent for `TransferWallet`, which has
 * no count in the schema.
 */
export type CarfBlock = {
  category: CarfCategory;
  /** `ExchangeType` (CARF401–404) or `TransferType` (CARF501–509, 601–606). */
  type?: string;
  transactions?: number;
  amount: string;
  /** The `currCode` attribute of `Amount`. */
  currency: string;
  units: string;
  altValuation?: string;
};

/** One `RelevantTransactions` element: a crypto-asset and its blocks. */
export type CarfAssetReport = { name: string; blocks: CarfBlock[] };

export type CarfTin = { value: string; issuedBy?: string };

/** One `CryptoUsers` element. */
export type CarfUser = {
  name: string;
  tins: CarfTin[];
  docRefId: string;
  /** OECD0–3, OECD10–13; OECD3 marks a deletion. */
  docTypeIndic: string;
  assets: CarfAssetReport[];
};

export type CarfMessage = {
  messageRefId: string;
  /** CARF701 new data, CARF702 corrections, CARF703 nothing to report. */
  messageTypeIndic: string;
  /** xsd:date, the last day of the reporting period. */
  reportingPeriod: string;
  year: number;
  timestamp: string;
  transmittingCountry: string;
  receivingCountry: string;
  provider: { name: string; docRefId: string };
  users: CarfUser[];
};
