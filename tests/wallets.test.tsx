import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
// Needed so interpolated t() calls (e.g. 'Delete {{name}}') actually
// substitute their variables instead of rendering the raw key - see
// tests/assetSearch.test.tsx / tests/notify.test.tsx for the same pattern.
import '@/i18n';
import { StorageDataProvider } from '@/components/data/StorageDataProvider';
import { ConfirmProvider } from '@/components/confirm/ConfirmProvider';
import { WalletList } from '@/components/wallets/WalletList';
import { credentialKey } from '@/lib/credentials';

beforeEach(async () => {
  localStorage.clear();
  const storage = (await import('@/persistence/storage')).default;
  for (const exchange of await storage.exchanges.getAll()) {
    await storage.exchanges.delete(exchange.id);
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      media: '',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});

const renderList = () =>
  render(
    <StorageDataProvider>
      <ConfirmProvider>
        <WalletList />
      </ConfirmProvider>
    </StorageDataProvider>,
  );

describe('wallet list', () => {
  it('tells a first-time user what to do when there are none', async () => {
    renderList();
    expect(await screen.findByText(/no wallets yet/i)).toBeInTheDocument();
  });

  it('adds a wallet and shows it in the list', async () => {
    renderList();
    await userEvent.click(
      await screen.findByRole('button', { name: /add wallet/i }),
    );
    await userEvent.type(
      await screen.findByLabelText(/wallet name/i),
      'Kraken',
    );
    await userEvent.click(await screen.findByRole('button', { name: /^Add$/ }));

    expect(await screen.findByText('Kraken')).toBeInTheDocument();
  });

  it('does not blank an untouched credential field on Save', async () => {
    // Renaming can't actually orphan a credential - the key has no name
    // component (credentialKey is keyed on id only) - so this test cannot
    // catch a rename regression by construction. What it genuinely pins is
    // that Save leaves an untouched field's stored credential alone rather
    // than overwriting it with an empty string: WalletCredentials seeds its
    // input from readCredential() and WalletRow only calls writeCredential
    // for fields present in its local `credentials` state, so a field the
    // user never typed into never gets a `''` write. A naive
    // `writeCredential(id, field, credentials[field] ?? '')` on every
    // known field would blank it, and this test would catch that.
    const storage = (await import('@/persistence/storage')).default;
    await storage.exchanges.add({ name: 'Binance', type: 'BinanceApiSync' });
    const [exchange] = await storage.exchanges.getAll();
    localStorage.setItem(
      credentialKey(exchange.id, 'binanceApiKey'),
      'secret-key',
    );

    renderList();
    // Anchored so this opens the ROW (whose accessible name starts with
    // the wallet name) rather than the delete button, whose accessible
    // name is "Delete Binance" and would otherwise also match /Binance/.
    await userEvent.click(
      await screen.findByRole('button', { name: /^Binance/ }),
    );
    const nameField = await screen.findByLabelText(/wallet name/i);
    await userEvent.clear(nameField);
    await userEvent.type(nameField, 'Binance Main');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    await waitFor(() =>
      expect(screen.getByText('Binance Main')).toBeInTheDocument(),
    );
    expect(
      localStorage.getItem(credentialKey(exchange.id, 'binanceApiKey')),
    ).toBe('secret-key');
  });

  it('persists credentials against the type the user actually chose', async () => {
    // The old saveWallet resolved the sync source from the PRE-EDIT type, so
    // changing a wallet's type in the same edit never persisted or migrated
    // its credentials.
    const storage = (await import('@/persistence/storage')).default;
    await storage.exchanges.add({ name: 'Wallet', type: 'Other' });
    const [exchange] = await storage.exchanges.getAll();

    renderList();
    // Anchored for the same reason as above: the delete button's
    // accessible name is "Delete Wallet", which also contains "Wallet".
    await userEvent.click(
      await screen.findByRole('button', { name: /^Wallet/ }),
    );
    await userEvent.click(await screen.findByLabelText(/wallet type/i));
    await userEvent.click(
      await screen.findByRole('option', { name: /Binance/i }),
    );

    const apiKey = await screen.findByLabelText(/API Key/i);
    await userEvent.type(apiKey, 'typed-after-switch');
    // The unencrypted-storage disclosure is spec-mandated, not optional -
    // assert it is actually on screen once credential fields are showing,
    // rather than resting on reading WalletCredentials' source.
    expect(screen.getByText(/stored unencrypted/i)).toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    await waitFor(() =>
      expect(
        localStorage.getItem(credentialKey(exchange.id, 'binanceApiKey')),
      ).toBe('typed-after-switch'),
    );
  });

  it('normalises the legacy lowercase "other" type instead of showing a blank selector', async () => {
    // The shipped app wrote this sentinel in lowercase ('other'), which
    // matches no SelectItem's value here (OTHER is 'Other'). Every
    // pre-existing non-Binance wallet has to still show a real selection.
    const storage = (await import('@/persistence/storage')).default;
    await storage.exchanges.add({ name: 'Legacy Wallet', type: 'other' });

    renderList();
    await userEvent.click(
      await screen.findByRole('button', { name: /^Legacy Wallet/ }),
    );
    await userEvent.click(await screen.findByLabelText(/wallet type/i));

    const otherOption = await screen.findByRole('option', { name: 'Other' });
    expect(otherOption).toHaveAttribute('data-state', 'checked');
  });

  it('names a duplicate name on the field when renaming, not as a generic failure', async () => {
    // exchanges.name is a unique index, so a collision arrives as a
    // ConstraintError. Reporting it as "Failed to save wallet information"
    // told the user the save failed for reasons unknown, while the add path
    // in WalletList already named exactly this cause inline.
    const storage = (await import('@/persistence/storage')).default;
    await storage.exchanges.add({ name: 'Kraken', type: 'Other' });
    await storage.exchanges.add({ name: 'Binance', type: 'Other' });

    renderList();
    await userEvent.click(
      await screen.findByRole('button', { name: /^Kraken/ }),
    );
    const nameField = await screen.findByLabelText(/wallet name/i);
    await userEvent.clear(nameField);
    await userEvent.type(nameField, 'Binance');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    expect(nameField).toHaveAttribute('aria-invalid', 'true');
  });

  it('clears the credentials of a sync source the wallet is switched away from', async () => {
    // Save wrote only the selected source's fields, so a Binance wallet set
    // to Other left both API keys in localStorage indefinitely - a secret
    // the user believes they removed.
    const storage = (await import('@/persistence/storage')).default;
    await storage.exchanges.add({ name: 'Binance', type: 'BinanceApiSync' });
    const [exchange] = await storage.exchanges.getAll();
    localStorage.setItem(credentialKey(exchange.id, 'binanceApiKey'), 'key');
    localStorage.setItem(
      credentialKey(exchange.id, 'binanceSecretKey'),
      'secret',
    );

    renderList();
    await userEvent.click(
      await screen.findByRole('button', { name: /^Binance/ }),
    );
    await userEvent.click(await screen.findByLabelText(/wallet type/i));
    await userEvent.click(await screen.findByRole('option', { name: 'Other' }));
    await userEvent.click(
      await screen.findByRole('button', { name: /^Save$/ }),
    );

    await waitFor(() =>
      expect(
        localStorage.getItem(credentialKey(exchange.id, 'binanceApiKey')),
      ).toBeNull(),
    );
    expect(
      localStorage.getItem(credentialKey(exchange.id, 'binanceSecretKey')),
    ).toBeNull();
  });

  it('warns what a delete destroys, and clears its credentials', async () => {
    const storage = (await import('@/persistence/storage')).default;
    await storage.exchanges.add({ name: 'Binance', type: 'BinanceApiSync' });
    const [exchange] = await storage.exchanges.getAll();
    localStorage.setItem(credentialKey(exchange.id, 'binanceApiKey'), 'secret');

    renderList();
    await userEvent.click(
      await screen.findByRole('button', { name: /Delete Binance/i }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/API credentials/i);
    await userEvent.click(
      await screen.findByRole('button', { name: /^Delete$/ }),
    );

    await waitFor(async () =>
      expect(await storage.exchanges.getAll()).toHaveLength(0),
    );
    // Cleared regardless of whether the field was mounted - the old code only
    // removed credentials whose input happened to be rendered.
    expect(
      localStorage.getItem(credentialKey(exchange.id, 'binanceApiKey')),
    ).toBeNull();
  });
});
