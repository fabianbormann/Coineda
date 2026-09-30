/**
 * Everything in Coineda is EUR-denominated - the transaction model
 * hardcodes euro as the fiat leg - so the fiat formatter takes no
 * currency argument.
 */
const FIAT_OPTIONS: Intl.NumberFormatOptions = {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
};

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
 */
export const formatFiat = (value: number, language: string): string =>
  Number.isFinite(value) ? safeFormat(value, language, FIAT_OPTIONS) : '—';

export const formatCrypto = (value: number, language: string): string =>
  Number.isFinite(value) ? safeFormat(value, language, CRYPTO_OPTIONS) : '—';
