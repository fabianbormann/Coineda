import { openLedger, openLedgerForWrite, type WriteOptions } from '@/ledger/db';
import type { CarryForward } from '@/tax/types';

/**
 * Freeform app settings backed by the 'settings' store (schema version 3).
 *
 * `getSettings()` returns `null` when nothing has been stored yet - the
 * onboarding flow (Task 10) distinguishes "not yet configured" from
 * "configured as empty".
 */
export type DatevSettings = {
  /** 1-7 digits. */
  beraternummer: string;
  /** 1-5 digits. */
  mandantennummer: string;
  /** 4-8. */
  sachkontenlaenge: number;
  /** The advisor's accounts, each exactly `sachkontenlaenge` digits. */
  konten: {
    verrechnung: string;
    gewinn23: string;
    verlust23: string;
    einkuenfte22: string;
  };
};

export type Settings = {
  language: string;
  baseCurrency: string;
  /**
   * Optional CoinGecko API key, used only for historical price lookups
   * (src/tax/resolveValues.ts). Sent as the x-cg-demo-api-key header, never
   * a query parameter. Deliberately NOT normalised by normalizeSettings
   * below - unlike baseCurrency, this is a credential and case matters.
   */
  coingeckoApiKey?: string;
  /**
   * Who the printed tax report is for. Optional, and empty by default.
   *
   * Personal data, so it is held exactly the way every other setting here
   * is: in this device's IndexedDB, leaving only inside an encrypted
   * checkpoint, never sent anywhere. The trade is deliberate - a printed
   * sheet a tax office cannot assign to a file is worthless, and the
   * alternative (writing it on by hand after every print) is what stops
   * people printing the report at all.
   *
   * Deliberately NOT normalised by normalizeSettings: a name's casing is
   * the person's own, and a Steuernummer's formatting differs per
   * Bundesland.
   */
  taxpayer?: {
    name?: string;
    /** Steuernummer or equivalent. For Germany with a `state`, stored in
     *  that Bundesland's notice format (src/settings/taxNumber.ts, e.g.
     *  `12/345/67890`); otherwise free text, which is also how a value
     *  stored before the state existed stays until it is edited. */
    taxNumber?: string;
    /** The Bundesland whose format `taxNumber` follows, as a two-letter
     *  code (BW, BY, BE, ...; see GERMAN_STATES). Germany only. */
    state?: string;
  };
  /**
   * Losses carried into a tax year, keyed by that year ("2025"). Entered by
   * the user from their Verlustfeststellungsbescheid, in the base currency;
   * only the Finanzamt knows the figure. Not normalised. putSettings merges
   * at the top level, so a write replaces this whole record.
   */
  lossCarryForward?: Record<string, CarryForward>;
  /**
   * The advisor's DATEV numbers and accounts for the Buchungsstapel export.
   * No defaults: Coineda does not know the advisor's Kontenrahmen. Not
   * normalised (spread through by normalizeSettings, account numbers keep
   * their leading zeros).
   */
  datev?: DatevSettings;
  // The egress mode and endpoint overrides are deliberately NOT here: they
  // are per device, not per client (src/config/deviceConfig.ts), so a
  // review client's settings cannot carry a mode of their own.
};

/**
 * Row keys inside the 'settings' store. Exported so `restoreCheckpoint`
 * (src/checkpoint/format.ts) can write into these exact rows from within
 * its own atomic transaction - calling `putSettings`/`setOnboarded` there
 * would each open their own transaction via `openLedger()` and break the
 * single-transaction guarantee restore depends on.
 */
export const SETTINGS_KEY = 'settings';
export const ONBOARDED_KEY = 'onboarded';

/**
 * Currency casing is not normalised anywhere else in the codebase.
 * `src/prices/priceStore.ts` compares a holding's asset id against
 * `` `fiat:${currency}` `` in lowercase, so a base currency persisted as
 * 'EUR' would never match 'fiat:eur' and would silently drop the user's
 * euro balance out of their total. Exported so `restoreCheckpoint` applies
 * this identical rule when it writes settings directly, rather than a
 * second copy that could drift.
 */
export const normalizeSettings = (
  settings: Partial<Settings>,
): Partial<Settings> => ({
  ...settings,
  ...(settings.baseCurrency !== undefined
    ? { baseCurrency: settings.baseCurrency.toLowerCase() }
    : {}),
});

export const getSettings = async (): Promise<Settings | null> => {
  const db = await openLedger();
  const row = await db.get('settings', SETTINGS_KEY);
  return (row?.value as Settings | undefined) ?? null;
};

export const putSettings = async (
  partial: Partial<Settings>,
  options?: WriteOptions,
): Promise<void> => {
  const db = await openLedgerForWrite(options);
  const existing = await db.get('settings', SETTINGS_KEY);
  const merged = {
    ...(existing?.value as Partial<Settings> | undefined),
    ...partial,
  };
  await db.put('settings', {
    key: SETTINGS_KEY,
    value: normalizeSettings(merged),
  });
};

export const isOnboarded = async (): Promise<boolean> => {
  const db = await openLedger();
  const row = await db.get('settings', ONBOARDED_KEY);
  return row?.value === true;
};

export const setOnboarded = async (options?: WriteOptions): Promise<void> => {
  const db = await openLedgerForWrite(options);
  await db.put('settings', { key: ONBOARDED_KEY, value: true });
};
