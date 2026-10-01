import { ArrowDown, ArrowUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatFiat } from './format';

/**
 * A signed fiat delta.
 *
 * Direction is ALWAYS carried four ways at once: an explicit sign, a
 * direction glyph, the token colour, and a visually-hidden word for
 * assistive tech. Never colour alone - red-green colour deficiency
 * affects roughly 8% of men and "is this a gain or a loss" is this
 * application's primary output. The sign and glyph alone are not enough
 * for screen-reader users either: U+2212 MINUS SIGN (used below for
 * digit alignment) is outside NVDA's default symbol dictionary and its
 * negative-number heuristic keys on ASCII hyphen-minus, not Unicode
 * minus, so a blind user can hear "€318.20" for a loss with no audible
 * cue at all. The `sr-only` prefix fixes that without touching the
 * number's own reading (an `aria-label` on the container would replace
 * it instead).
 *
 * The visible sign character is `aria-hidden`: screen readers that DO
 * announce U+2212 (VoiceOver, JAWS at punctuation=some) would otherwise
 * read "Loss of minus 318.20" - the sign and the `sr-only` word both
 * asserting direction aurally, redundantly and confusingly. Hiding the
 * sign leaves direction carried by three visual channels (sign, glyph,
 * colour) and exactly one aural one (the hidden word), and preserves the
 * digit alignment the sign was chosen for - `aria-hidden` does not
 * remove it from the DOM or from `textContent`, only from the
 * accessibility tree. Tests assert the sign, glyph and hidden word are
 * present, so a refactor cannot quietly reduce this to colour.
 *
 * Zero is not a direction: no glyph, no gain/loss colour, no hidden word.
 */
export const GainLoss = ({
  value,
  currency,
  className,
}: {
  value: number;
  /** Lowercase code from `settings.baseCurrency` - see Money. */
  currency: string;
  className?: string;
}) => {
  const { t, i18n } = useTranslation();

  const isGain = value > 0;
  const isLoss = value < 0;
  // U+2212 MINUS SIGN, not a hyphen: it aligns with digits in tabular
  // figures, where a hyphen does not.
  const sign = isGain ? '+' : isLoss ? '−' : '';
  const Arrow = isGain ? ArrowUp : ArrowDown;

  return (
    <span
      data-testid="gain-loss"
      className={cn(
        'inline-flex items-center gap-1 tabular-nums',
        isGain && 'text-gain',
        isLoss && 'text-loss',
        className,
      )}
    >
      {(isGain || isLoss) && (
        <Arrow
          className="size-3.5 shrink-0"
          aria-hidden="true"
          data-direction={isGain ? 'up' : 'down'}
        />
      )}
      {isGain && <span className="sr-only">{t('Gain of')} </span>}
      {isLoss && <span className="sr-only">{t('Loss of')} </span>}
      <span aria-hidden="true">{sign}</span>
      {formatFiat(Math.abs(value), i18n.language, currency)}
    </span>
  );
};
