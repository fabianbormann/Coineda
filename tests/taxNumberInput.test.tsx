import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import '@/i18n';
import { TaxNumberInput } from '@/components/forms/TaxNumberInput';
import type { GermanState } from '@/settings/taxNumber';

/** The input with its value held the way the screen holds it. */
const Harness = ({
  state,
  initial = '',
  onChange = () => {},
}: {
  state: GermanState | undefined;
  initial?: string;
  onChange?: (value: string) => void;
}) => {
  const [value, setValue] = useState(initial);
  return (
    <TaxNumberInput
      id="tax-number"
      label="Tax number (optional)"
      state={state}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
};

const input = () => screen.getByLabelText('Tax number (optional)');

describe('the masked tax number input', () => {
  it('formats digits into the state mask as they are typed', async () => {
    render(<Harness state="BY" />);
    await userEvent.type(input(), '12345678901');
    expect(input()).toHaveValue('123/456/78901');
  });

  it('ignores letters and stops at the mask length', async () => {
    render(<Harness state="NW" />);
    await userEvent.type(input(), '12a3-4567890123');
    expect(input()).toHaveValue('123/4567/8901');
  });

  it('shows the open positions as a muted mask, never in the value', async () => {
    const onChange = vi.fn();
    render(<Harness state="HB" onChange={onChange} />);
    await userEvent.type(input(), '123');
    expect(input()).toHaveValue('12 3');
    expect(screen.getByTestId('tax-number-mask-rest')).toHaveTextContent(
      /^00 00000$/,
    );
    expect(onChange).toHaveBeenLastCalledWith('12 3');
  });

  it('deletes the digit before a separator on Backspace, keeping the separator', async () => {
    render(<Harness state="BY" initial="123/456" />);
    await userEvent.click(input());
    // Caret right after the first "/".
    (input() as HTMLInputElement).setSelectionRange(4, 4);
    await userEvent.keyboard('{Backspace}');
    expect(input()).toHaveValue('124/56');
  });

  it('cannot remove a separator with Delete either', async () => {
    render(<Harness state="BY" initial="123/456" />);
    await userEvent.click(input());
    // Caret right before the first "/".
    (input() as HTMLInputElement).setSelectionRange(3, 3);
    await userEvent.keyboard('{Delete}');
    expect(input()).toHaveValue('123/56');
  });

  it.each([['12 345 67890'], ['1234567890'], ['12/345/67890']])(
    'fills the digits of a pasted %s',
    async (pasted) => {
      render(<Harness state="BE" />);
      await userEvent.click(input());
      await userEvent.paste(pasted);
      expect(input()).toHaveValue('12/345/67890');
    },
  );

  it('names the format in a hint the input is described by', () => {
    render(<Harness state="BE" />);
    expect(input()).toHaveAttribute('inputmode', 'numeric');
    expect(input()).toHaveAccessibleDescription('Format 12/345/67890');
  });

  it('is disabled until a state is chosen, and says so', () => {
    render(<Harness state={undefined} />);
    expect(input()).toBeDisabled();
    expect(input()).toHaveAccessibleDescription('Choose your state first');
  });

  it('shows a value in another format as it is, with a note, until edited', async () => {
    render(<Harness state="BE" initial="123/456/78901" />);
    expect(input()).toHaveValue('123/456/78901');
    expect(
      screen.getByText('Does not match the format for Berlin'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('tax-number-mask')).toBeNull();

    await userEvent.clear(input());
    await userEvent.type(input(), '1234567890');
    expect(input()).toHaveValue('12/345/67890');
    expect(screen.queryByText(/does not match the format/i)).toBeNull();
  });
});
