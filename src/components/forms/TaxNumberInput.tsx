import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  STATE_NAMES,
  caretAfterDigits,
  digitCountOf,
  digitsOf,
  formatDigits,
  isCanonical,
  maskOf,
  type GermanState,
} from '@/settings/taxNumber';

type TaxNumberInputProps = {
  id: string;
  label: string;
  /** The Bundesland whose format applies; the input is disabled without. */
  state: GermanState | undefined;
  /** As stored: formatted, or a legacy value in some other format. */
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
};

/**
 * A German Steuernummer in the notice format of the chosen Bundesland.
 *
 * Digits only; the separators are fixed. Every edit (typing, pasting,
 * deleting, replacing a selection) is reduced to the digits it leaves and
 * re-formatted, so no keystroke can remove or move a separator - and
 * Backspace (Delete) right after (before) one removes the digit beyond it
 * rather than doing nothing. The positions still open show as a muted `0`
 * mask behind the text, never part of the value.
 *
 * A value that is not in the state's format (one stored before the state
 * existed, or one kept from another state) is shown as it is, with a note,
 * until it is edited.
 */
export const TaxNumberInput = ({
  id,
  label,
  state,
  value,
  onChange,
  onBlur,
  disabled = false,
}: TaxNumberInputProps) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  // Where the caret belongs after the value React is about to write.
  const caretRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const caret = caretRef.current;
    caretRef.current = null;
    if (input && caret !== null && document.activeElement === input) {
      input.setSelectionRange(caret, caret);
    }
  }, [value]);

  const canonical = state === undefined || isCanonical(state, value);
  const hintId = `${id}-hint`;
  const noteId = `${id}-note`;

  /** Writes `digits` formatted, with the caret after `caretDigits` of them. */
  const commit = (digits: string, caretDigits: number) => {
    if (!state) {
      return;
    }
    const kept = digits.slice(0, digitCountOf(state));
    const next = formatDigits(state, kept);
    caretRef.current = caretAfterDigits(
      next,
      Math.min(caretDigits, kept.length),
    );
    onChange(next);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const start = input.selectionStart;
    if (
      !state ||
      !canonical ||
      start === null ||
      start !== input.selectionEnd ||
      (event.key !== 'Backspace' && event.key !== 'Delete')
    ) {
      return;
    }
    const isSeparator = (char: string | undefined) =>
      char !== undefined && !/\d/.test(char);
    const digits = digitsOf(value);
    const before = digitsOf(value.slice(0, start)).length;
    if (event.key === 'Backspace' && isSeparator(value[start - 1])) {
      event.preventDefault();
      if (before > 0) {
        commit(digits.slice(0, before - 1) + digits.slice(before), before - 1);
      }
    } else if (event.key === 'Delete' && isSeparator(value[start])) {
      event.preventDefault();
      commit(digits.slice(0, before) + digits.slice(before + 1), before);
    }
  };

  const example = state
    ? formatDigits(state, '1234567890123'.slice(0, digitCountOf(state)))
    : '';

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          ref={inputRef}
          id={id}
          className="font-mono"
          inputMode="numeric"
          autoComplete="off"
          value={value}
          onChange={(event) => {
            const raw = event.target.value;
            const caret = event.target.selectionStart ?? raw.length;
            commit(digitsOf(raw), digitsOf(raw.slice(0, caret)).length);
          }}
          onKeyDown={handleKeyDown}
          onBlur={onBlur}
          disabled={disabled || !state}
          aria-describedby={canonical ? hintId : `${hintId} ${noteId}`}
        />
        {state && canonical && !disabled && (
          <div
            aria-hidden="true"
            data-testid={`${id}-mask`}
            className="pointer-events-none absolute inset-0 flex items-center overflow-hidden border border-transparent px-3 py-1 font-mono text-base md:text-sm"
          >
            <span className="invisible whitespace-pre">{value}</span>
            <span
              data-testid={`${id}-mask-rest`}
              className="whitespace-pre text-muted-foreground"
            >
              {maskOf(state).slice(value.length)}
            </span>
          </div>
        )}
      </div>
      <p id={hintId} className="text-sm text-muted-foreground">
        {state
          ? t('Format {{example}}', { example })
          : t('Choose your state first')}
      </p>
      {!canonical && state && (
        <p id={noteId} className="text-sm text-destructive">
          {t('Does not match the format for {{state}}', {
            state: t(STATE_NAMES[state]),
          })}
        </p>
      )}
    </div>
  );
};
