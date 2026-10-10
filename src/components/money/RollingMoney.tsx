import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatFiat } from './format';

/**
 * When the last column comes to rest. The first lands at FIRST_LANDING_MS
 * and the rest are spread between them, so the low digits keep turning
 * after the high ones have settled - which is what makes it read as one
 * counter rather than as seven numbers changing at once.
 */
const LAST_LANDING_MS = 1600;
const FIRST_LANDING_MS = 900;

/** One full turn of a column, in digit-heights. */
const CYCLE = 10;

const isDigit = (character: string): boolean =>
  character >= '0' && character <= '9';

/**
 * The strip a column scrolls through: whole turns of 0-9, as ONE text node
 * with a newline between each digit.
 *
 * Deliberately not one element per digit. A seven-digit balance with turns
 * increasing left to right needs ~350 of them, and they exist only to be
 * one line tall each - which `white-space: pre` with `line-height: 1` gives
 * for free, at one node per column instead.
 */
const strip = (turns: number): string =>
  Array.from({ length: turns + 1 }, () => '0123456789'.split('').join('\n'))
    .join('\n')
    .concat('\n0');

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The headline balance, arriving as a counter rather than as a jump.
 *
 * The overview starts at `useState(0)` and prices its holdings in an
 * effect, so navigating away and back unmounts it, drops the total to zero
 * and recomputes - which is visible as the figure flashing 0 before
 * snapping to the real number. This does not close that window and nothing
 * can: the figure is genuinely unknown until the prices resolve, so there
 * is no value to roll towards before then. What it changes is how the
 * number lands once it is known.
 *
 * Which is also why it rolls ONLY out of zero. A later sync that moves the
 * total by a fraction of a percent is not an arrival, and restaging the
 * whole counter for it would be noise the third time someone saw it.
 *
 * Separate from `Money` rather than a prop on it: `Money` also renders
 * every per-source row, and a screen full of counters is a different and
 * much worse idea than one.
 */
export const RollingMoney = ({
  value,
  currency,
  className,
}: {
  value: number;
  currency: string;
  className?: string;
}) => {
  const { i18n } = useTranslation();
  const formatted = formatFiat(value, i18n.language, currency);

  const [rolling, setRolling] = useState(false);
  const previous = useRef(value);

  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    // Out of zero only, and never into it - see the doc comment above.
    if (from !== 0 || value === 0 || prefersReducedMotion()) {
      return;
    }
    setRolling(true);
    // The columns exist only while they are moving. Once they have landed
    // the figure goes back to being plain text, so nothing downstream -
    // selection, copy, a screen reader that ignores aria-hidden - has to
    // keep stepping around a stack of digits that is no longer doing
    // anything.
    const settled = setTimeout(() => setRolling(false), LAST_LANDING_MS);
    return () => clearTimeout(settled);
  }, [value]);

  // The same live-region wrapper whether rolling or settled, so what screen
  // readers are watching is never swapped out underneath them.
  if (!rolling) {
    return (
      <span
        aria-live="polite"
        aria-atomic="true"
        className={cn('tabular-nums', className)}
      >
        <span data-testid="rolling-value">{formatted}</span>
      </span>
    );
  }

  const characters = [...formatted];
  const digitCount = characters.filter(isDigit).length;
  // Every column starts together and runs for a different length, so the
  // stagger comes out of the durations rather than out of delays.
  const step =
    digitCount > 1
      ? (LAST_LANDING_MS - FIRST_LANDING_MS) / (digitCount - 1)
      : 0;

  let column = -1;
  return (
    <span
      aria-live="polite"
      aria-atomic="true"
      className={cn('tabular-nums', className)}
    >
      {/* The figure itself, for anything that reads rather than looks. The
          columns below carry every digit of every turn in their text, so
          this is the only place the number can be read back. */}
      <span className="sr-only" data-testid="rolling-value">
        {formatted}
      </span>
      <span aria-hidden="true" className="inline-flex leading-none">
        {characters.map((character, index) => {
          if (!isDigit(character)) {
            return <span key={index}>{character}</span>;
          }
          column += 1;
          const turns = 1 + column;
          const travel = turns * CYCLE + Number(character);
          return (
            <span
              key={index}
              data-testid="rolling-digit"
              data-digit={character}
              data-travel={travel}
              className="inline-block h-[1em] overflow-hidden leading-none"
            >
              <span
                className="roll-strip"
                style={
                  {
                    '--lm-roll-to': `-${travel}em`,
                    animationDuration: `${FIRST_LANDING_MS + column * step}ms`,
                  } as CSSProperties
                }
              >
                {strip(turns)}
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
};
