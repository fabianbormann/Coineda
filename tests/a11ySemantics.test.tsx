import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import '@/i18n';
import App from '../src/App';
import { FileDropArea } from '@/components/files/FileDropArea';
import { MapCsvDialog } from '@/screens/MapCsvDialog';
import { StartFresh } from '@/onboarding/StartFresh';
import { DEFAULT_LEDGER_NAME, openLedger, setActiveLedger } from '@/ledger/db';
import { setOnboarded } from '@/settings/settingsStore';

describe('FileDropArea', () => {
  it('keeps the file input outside the button and out of the tab order', async () => {
    const { container } = render(<FileDropArea onFile={() => {}} />);
    const button = screen.getByRole('button');
    const input = container.querySelector('input[type="file"]')!;
    expect(input).not.toBeNull();
    expect(button.contains(input)).toBe(false);
    expect(input).toHaveAttribute('tabindex', '-1');
    const click = vi.spyOn(input as HTMLInputElement, 'click');
    await userEvent.click(button);
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe('MapCsvDialog semantics', () => {
  const csv = 'Datum;Coin;Menge\n07.03.2024;BTC;0,5\n';
  const renderDialog = async () => {
    render(
      <MapCsvDialog
        open
        onOpenChange={() => {}}
        onImport={async () => {}}
        file={new File([csv], 'a.csv', { type: 'text/csv' })}
        label="Bison"
      />,
    );
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(dialog.querySelectorAll('th').length).toBeGreaterThan(0),
    );
    return dialog;
  };

  it('gives preview headers a column scope', async () => {
    const dialog = await renderDialog();
    dialog
      .querySelectorAll('th')
      .forEach((th) => expect(th).toHaveAttribute('scope', 'col'));
  });

  it('has one accessible name per control, legends and no radiogroup fieldsets', async () => {
    const dialog = await renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(dialog.querySelectorAll('fieldset').length).toBeGreaterThan(0),
    );
    let labelled = 0;
    dialog.querySelectorAll('input, select').forEach((control) => {
      if (control.id && dialog.querySelector(`label[for="${control.id}"]`)) {
        labelled++;
        expect(control).not.toHaveAttribute('aria-label');
      }
    });
    expect(labelled).toBeGreaterThan(5);
    dialog.querySelectorAll('fieldset').forEach((set) => {
      expect(set.querySelector(':scope > legend')).not.toBeNull();
      expect(set).not.toHaveAttribute('role', 'radiogroup');
    });
  });
});

describe('ClientMenu semantics', () => {
  beforeEach(async () => {
    localStorage.clear();
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: false,
        media: '',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    await setActiveLedger(DEFAULT_LEDGER_NAME);
    const db = await openLedger();
    for (const store of ['events', 'sources', 'cursors', 'settings'] as const) {
      await db.clear(store);
    }
    await setOnboarded();
  });

  it('hides the check glyph and keeps paragraphs out of the menu', async () => {
    render(<App />);
    await userEvent.click(
      await screen.findByRole('button', { name: /clients/i }),
    );
    const menu = await screen.findByRole('menu');
    const glyph = [...menu.querySelectorAll('[aria-hidden="true"]')].find(
      (n) => n.textContent === '✓',
    );
    expect(glyph).toBeTruthy();
    expect(menu.querySelector('p')).toBeNull();
  });
});

describe('StartFresh', () => {
  it('marks each language name with its own language', async () => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.scrollIntoView ??= () => {};
    render(<StartFresh onComplete={() => {}} onBack={() => {}} />);
    fireEvent.keyDown(screen.getByRole('combobox', { name: /language/i }), {
      key: 'ArrowDown',
    });
    const de = await screen.findByRole('option', { name: 'Deutsch' });
    const en = screen.getByRole('option', { name: 'English' });
    expect(de).toHaveAttribute('lang', 'de');
    expect(en).toHaveAttribute('lang', 'en');
  });
});

describe('heading levels in dialogs', () => {
  const files = [
    ...readdirSync('src', { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('Dialog.tsx') && !f.startsWith('components'))
      .map((f) => `src/${f}`),
    ...readdirSync('src/onboarding')
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => `src/onboarding/${f}`),
  ];

  it('finds the files', () => expect(files.length).toBeGreaterThan(8));

  it.each(files)('%s has no h1/h2 and skips no level', (file) => {
    const source = readFileSync(file, 'utf8');
    if (file.endsWith('Dialog.tsx')) {
      expect(source).toContain('DialogTitle');
    }
    expect(source).not.toMatch(/<h[12][\s>]/);
    const levels = [...source.matchAll(/<h([3-6])[\s>]/g)].map((m) =>
      Number(m[1]),
    );
    const max = Math.max(0, ...levels);
    for (let level = 4; level <= max; level++) {
      expect(levels).toContain(level - 1);
    }
  });
});
