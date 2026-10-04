import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from '@/i18n';
import { Money } from '@/components/money/Money';
import { CryptoAmount } from '@/components/money/CryptoAmount';
import { GainLoss } from '@/components/money/GainLoss';
import { formatCrypto, formatFiat } from '@/components/money/format';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('fiat formatting', () => {
  it('uses the active locale, so German reads 1.234,56 and English 1,234.56', async () => {
    const { rerender } = render(<Money value={1234.56} currency="eur" />);
    expect(screen.getByText(/1,234\.56/)).toBeInTheDocument();

    await i18n.changeLanguage('de');
    rerender(<Money value={1234.56} currency="eur" />);
    expect(screen.getByText(/1\.234,56/)).toBeInTheDocument();
  });

  it('renders the base currency rather than always euro', () => {
    // The formatter used to hardcode currency: 'EUR' under a comment
    // carried over from v1 ("everything in Coineda is EUR-denominated").
    // v2 has settings.baseCurrency, and localeDefaults makes 'usd' the
    // fallback for most users - so the default path priced a total in
    // dollars and then stamped a euro sign on it.
    expect(formatFiat(200, 'en', 'usd')).toContain('$');
    expect(formatFiat(200, 'en', 'usd')).not.toContain('\u20ac');
    expect(formatFiat(200, 'en', 'eur')).toContain('\u20ac');
    expect(formatFiat(200, 'en', 'gbp')).toContain('\u00a3');
  });

  it('accepts the lowercased code settings actually store', () => {
    // normalizeSettings lowercases baseCurrency deliberately (priceStore
    // compares against `fiat:${currency}` in lowercase), so the value
    // reaching this formatter is always lowercase.
    expect(formatFiat(200, 'en', 'usd')).toBe(formatFiat(200, 'en', 'USD'));
  });

  it('degrades instead of throwing on a currency code Intl rejects', () => {
    // A stored currency is user-entered via onboarding's free-text-capable
    // select; a RangeError here would crash every figure on the screen.
    expect(() => formatFiat(200, 'en', 'not-a-currency')).not.toThrow();
    expect(formatFiat(200, 'en', 'not-a-currency')).toMatch(/200/);
  });

  it('does not throw on an unexpected language tag', () => {
    // i18n.language can be 'de', 'de-DE', or something odd from browser
    // detection. A throwing formatter would crash every figure on every
    // screen, so this must degrade rather than explode.
    expect(() => formatFiat(1234.56, 'not-a-locale', 'eur')).not.toThrow();
    expect(formatFiat(1234.56, 'not-a-locale', 'eur')).toMatch(/1/);
  });

  it('renders with tabular figures so columns align', () => {
    render(<Money value={12} currency="eur" />);
    expect(screen.getByText(/12/)).toHaveClass('tabular-nums');
  });
});

describe('crypto amounts', () => {
  it('keeps small quantities legible instead of rounding to fiat precision', () => {
    // Fiat formatting would render this as 0.00, which is a lie about the
    // user's holdings.
    const output = formatCrypto('0.00004213', 'en');
    expect(output).not.toMatch(/^0\.00$/);
    expect(output).toMatch(/4213|4,213|0\.0000421/);
  });

  it('scales base units to whole units and names the asset', () => {
    // The caller hands over what the ledger stores - satoshis - and the
    // asset id, never a pre-scaled figure and never a symbol. The old
    // `symbol` prop let its one caller pass the raw id, which rendered
    // "10000000 cardano:lovelace" where the user holds 10 ADA.
    render(<CryptoAmount value="150000000" assetId="bitcoin:native" />);
    expect(screen.getByText(/^1\.5 BTC$/)).toBeInTheDocument();
  });

  it('does not render the technical asset id', () => {
    render(<CryptoAmount value="10000000" assetId="cardano:lovelace" />);
    expect(screen.getByText(/^10 ADA$/)).toBeInTheDocument();
    expect(screen.queryByText(/lovelace/)).not.toBeInTheDocument();
  });

  it('keeps large quantities exact instead of rounding the integer part', () => {
    // maximumSignificantDigits: 8 used to round this to 1,234,567,900 -
    // misreporting the holding by ~10 tokens. Billion-scale balances are
    // ordinary for assets like dogecoin/shiba-inu in assets.json.
    const output = formatCrypto('1234567890.5', 'en');
    expect(output).toBe('1,234,567,890.5');
  });
});

describe('non-finite values', () => {
  it('renders an em dash instead of "€NaN" for fiat', () => {
    render(<Money value={NaN} currency="eur" />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('renders an em dash instead of "€∞" for fiat', () => {
    render(<Money value={Infinity} currency="eur" />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders an em dash instead of a raw NaN for crypto amounts', () => {
    render(<CryptoAmount value="not-a-number" assetId="bitcoin:native" />);
    expect(screen.getByText(/—/)).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('renders GainLoss as a neutral em dash for NaN, with no sign, glyph or colour', () => {
    render(<GainLoss value={NaN} currency="eur" />);
    const el = screen.getByTestId('gain-loss');
    expect(el.textContent).toContain('—');
    expect(el.textContent).not.toMatch(/NaN/);
    expect(el.querySelector('[data-direction]')).toBeNull();
    expect(el).not.toHaveClass('text-gain');
    expect(el).not.toHaveClass('text-loss');
  });

  it('renders GainLoss with an em dash amount for Infinity, never "€∞"', () => {
    // Infinity > 0 is true, so this still reads as a "gain" direction-wise
    // (glyph/colour/sign) - only the amount itself is guaranteed non-lying.
    render(<GainLoss value={Infinity} currency="eur" />);
    const el = screen.getByTestId('gain-loss');
    expect(el.textContent).toContain('—');
    expect(el.textContent).not.toMatch(/∞/);
  });
});

describe('gain and loss', () => {
  it('never encodes direction in colour alone, for a gain', () => {
    render(<GainLoss value={1240.5} currency="eur" />);
    const el = screen.getByTestId('gain-loss');
    // A sign character AND a direction glyph, not just a class.
    expect(el.textContent).toContain('+');
    expect(el.querySelector('[data-direction="up"]')).not.toBeNull();
    expect(el).toHaveClass('text-gain');
  });

  it('never encodes direction in colour alone, for a loss', () => {
    render(<GainLoss value={-318.2} currency="eur" />);
    const el = screen.getByTestId('gain-loss');
    expect(el.textContent).toContain('−'); // U+2212 minus, not a hyphen
    expect(el.querySelector('[data-direction="down"]')).not.toBeNull();
    expect(el).toHaveClass('text-loss');
  });

  it('treats zero as no direction at all', () => {
    render(<GainLoss value={0} currency="eur" />);
    const el = screen.getByTestId('gain-loss');
    expect(el.querySelector('[data-direction]')).toBeNull();
    expect(el).not.toHaveClass('text-gain');
    expect(el).not.toHaveClass('text-loss');
  });

  it('hides the visible sign from assistive tech so it is not read aloud alongside the sr-only word', () => {
    // Screen readers that DO announce U+2212 (VoiceOver, JAWS at
    // punctuation=some) would otherwise read "Loss of minus 318.20". The
    // sign must stay in the DOM (textContent, digit alignment) but be
    // aria-hidden.
    render(<GainLoss value={-318.2} currency="eur" />);
    const el = screen.getByTestId('gain-loss');
    expect(el.textContent).toContain('−');
    const signEl = Array.from(el.children).find(
      (child) =>
        child.getAttribute('aria-hidden') === 'true' &&
        child.textContent === '−',
    );
    expect(signEl).toBeTruthy();
  });

  it('carries direction in words for assistive tech too, not just the sign and glyph', () => {
    // U+2212 MINUS SIGN is outside NVDA's default symbol dictionary and its
    // negative-number heuristic keys on ASCII hyphen-minus, so the sign
    // alone is not a reliable non-visual signal. A visually-hidden word
    // must carry direction independently of that character.
    const { rerender } = render(<GainLoss value={1240.5} currency="eur" />);
    expect(screen.getByText('Gain of')).toHaveClass('sr-only');
    expect(screen.queryByText('Loss of')).toBeNull();

    rerender(<GainLoss value={-318.2} currency="eur" />);
    expect(screen.getByText('Loss of')).toHaveClass('sr-only');
    expect(screen.queryByText('Gain of')).toBeNull();

    rerender(<GainLoss value={0} currency="eur" />);
    expect(screen.queryByText('Gain of')).toBeNull();
    expect(screen.queryByText('Loss of')).toBeNull();
  });
});
