import { openLedger } from '@/ledger/db';

/**
 * Freeform app settings backed by the 'settings' store (schema version 3).
 *
 * `getSettings()` returns `null` when nothing has been stored yet - the
 * onboarding flow (Task 10) distinguishes "not yet configured" from
 * "configured as empty".
 */
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
): Promise<void> => {
  const db = await openLedger();
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

export const setOnboarded = async (): Promise<void> => {
  const db = await openLedger();
  await db.put('settings', { key: ONBOARDED_KEY, value: true });
};
