/**
 * The currency is a parameter, never a constant: v2 stores
 * `settings.baseCurrency` and prices every total in it, so a fixed 'EUR'
 * here would stamp a euro sign on a dollar figure - and 'usd' is
 * localeDefaults' fallback, i.e. what most users get.
 *
 * Settings store the code lowercased on purpose (see `normalizeSettings` -
 * priceStore compares a holding's id against `fiat:${currency}` in
 * lowercase), and this is the one place it is uppercased again. ECMA-402
 * canonicalises a well-formed code itself, so lowercase would format
 * identically; uppercasing here is to keep the ISO form explicit at the
 * boundary rather than to work around an engine, and it belongs here
 * rather than in any caller.
 */
const fiatOptions = (currency: string): Intl.NumberFormatOptions => ({
  style: 'currency',
  currency: currency.toUpperCase(),
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Crypto quantities need far more precision than fiat, at both ends of
 * the scale. Rounding 0.00004213 BTC to two places would misreport
 * someone's holdings; so would `maximumSignificantDigits`, which counts
 * digits on the *whole* number and therefore starts truncating the
 * integer part once a balance gets large - 1,234,567,890.5 (an entirely
 * normal balance for an asset like dogecoin or shiba-inu, both in
 * assets.json) rounds to 1,234,567,900 under 8 significant digits,
 * misreporting the holding by ~10 tokens. `maximumFractionDigits` bounds
 * only the fractional part, so it keeps small amounts legible without
 * ever touching integer digits, however large.
 */
const CRYPTO_OPTIONS: Intl.NumberFormatOptions = {
  maximumFractionDigits: 8,
};

/**
 * `i18n.language` may be 'de', 'de-DE', or an unexpected tag from browser
 * detection, and `Intl.NumberFormat` throws a RangeError on a malformed
 * one. A crashing formatter would take down every figure on every screen,
 * so fall back rather than propagate. The fallback attempt is wrapped too
 * - a `RangeError` originating in `options` rather than the locale would
 * otherwise throw again, uncaught, on the retry - with a last-resort
 * plain string so the function genuinely never throws.
 */
const safeFormat = (
  value: number,
  language: string,
  options: Intl.NumberFormatOptions,
): string => {
  try {
    return new Intl.NumberFormat(language, options).format(value);
  } catch {
    try {
      return new Intl.NumberFormat('en', options).format(value);
    } catch {
      return String(value);
    }
  }
};

/**
 * A non-finite value (NaN, +/-Infinity) is never a real amount - it is
 * what a failed CoinGecko fetch or a division by zero elsewhere in tax
 * arithmetic produces. Formatting it anyway renders "€NaN" or "€∞": a
 * broken value dressed up as a real one. Guarding here, rather than in
 * each caller, means every consumer (Money, CryptoAmount, GainLoss)
 * inherits the same total behaviour for free.
 *
 * `currency` is required rather than defaulted: a default is exactly how
 * the euro sign ended up on dollar totals, and a caller that cannot name
 * the currency does not know what the number means.
 */
export const formatFiat = (
  value: number,
  language: string,
  currency: string,
): string =>
  Number.isFinite(value)
    ? safeFormat(value, language, fiatOptions(currency))
    : '—';

/**
 * Takes a decimal string, not a number: the ledger never converts amounts
 * to numbers for arithmetic, and this function does none either -
 * `Number(value)` here exists solely to hand `Intl.NumberFormat` something
 * it can format.
 */
export const formatCrypto = (value: string, language: string): string => {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? safeFormat(numeric, language, CRYPTO_OPTIONS)
    : '—';
};
