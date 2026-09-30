import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import {
  StorageDataProvider,
  useStorageData,
} from '@/components/data/StorageDataProvider';
import type { CoinedaAsset, Exchange } from '@/global/types';

// storage.assets.add derives isFiat from whether the object carries
// `roughly_estimated_in_euro`, not from the `isFiat` field itself (see
// src/persistence/storage.js) - so a seeded "fiat" asset needs that extra
// property. It is deliberately not part of the CoinedaAsset type (nothing
// downstream of the seed step should depend on it), hence the local type.
type SeedAsset = CoinedaAsset & { roughly_estimated_in_euro?: number };

const Consumer = ({ id }: { id: string }) => {
  const { exchanges, addExchange } = useStorageData();
  return (
    <div>
      <ul data-testid={`list-${id}`}>
        {exchanges.map((e) => (
          <li key={e.name}>{e.name}</li>
        ))}
      </ul>
      <button type="button" onClick={() => addExchange(`added-by-${id}`)}>
        add-{id}
      </button>
    </div>
  );
};

const LoadingConsumer = () => {
  const { loadingExchanges, addExchange } = useStorageData();
  return (
    <div>
      <span data-testid="loading-exchanges">
        {loadingExchanges ? 'loading' : 'idle'}
      </span>
      <button type="button" onClick={() => addExchange('re-armed')}>
        reload
      </button>
    </div>
  );
};

const fiatAsset: SeedAsset = {
  id: 'test-fiat-xyz',
  symbol: 'test-fiat-xyz',
  isFiat: 1,
  roughly_estimated_in_euro: 0.9,
};

const cryptoAsset: CoinedaAsset = {
  id: 'test-crypto-xyz',
  symbol: 'test-crypto-xyz',
  isFiat: 2,
};

const AssetsConsumer = () => {
  const { assets, loadingAssets, addAsset, reloadAssets, assetsError } =
    useStorageData();
  return (
    <div>
      <span data-testid="loading-assets">
        {loadingAssets ? 'loading' : 'idle'}
      </span>
      <span data-testid="assets-error">{assetsError?.message ?? 'none'}</span>
      <ul data-testid="fiat-list">
        {assets.fiat.map((a) => (
          <li key={a.id}>{a.id}</li>
        ))}
      </ul>
      <ul data-testid="crypto-list">
        {assets.cryptocurrencies.map((a) => (
          <li key={a.id}>{a.id}</li>
        ))}
      </ul>
      <button type="button" onClick={() => addAsset(fiatAsset)}>
        add-fiat
      </button>
      <button type="button" onClick={() => addAsset(cryptoAsset)}>
        add-crypto
      </button>
      <button type="button" onClick={() => reloadAssets()}>
        reload-assets
      </button>
    </div>
  );
};

const ExchangesErrorConsumer = () => {
  const { exchangesError, reloadExchanges } = useStorageData();
  return (
    <div>
      <span data-testid="exchanges-error">
        {exchangesError?.message ?? 'none'}
      </span>
      <button type="button" onClick={() => reloadExchanges()}>
        reload-exchanges
      </button>
    </div>
  );
};

const PutExchangeConsumer = () => {
  const { exchanges, addExchange, putExchange } = useStorageData();
  return (
    <div>
      <ul data-testid="put-list">
        {exchanges.map((e) => (
          <li key={e.id}>
            {e.name}:{e.type ?? 'none'}
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => addExchange('renameable')}>
        seed
      </button>
      <button
        type="button"
        onClick={() => {
          const target = exchanges.find((e) => e.name === 'renameable');
          if (target) {
            putExchange({
              ...target,
              name: 'renamed',
              type: 'kraken',
            } as Exchange);
          }
        }}
      >
        rename
      </button>
    </div>
  );
};

const DeleteExchangeConsumer = () => {
  const { exchanges, addExchange, deleteExchange } = useStorageData();
  return (
    <div>
      <ul data-testid="delete-list">
        {exchanges.map((e) => (
          <li key={e.id}>{e.name}</li>
        ))}
      </ul>
      <button type="button" onClick={() => addExchange('removable')}>
        seed
      </button>
      <button
        type="button"
        onClick={() => {
          const target = exchanges.find((e) => e.name === 'removable');
          if (target) {
            deleteExchange(target.id);
          }
        }}
      >
        delete
      </button>
    </div>
  );
};

describe('shared storage data', () => {
  it('lets one consumer see what another added, with no refresh prop', async () => {
    // This is the bug ExchangeManager's `refreshExchanges` /
    // `forceRefreshExchanges` props exist to work around: two mounted
    // copies each fetched their own list and could not see each other.
    render(
      <StorageDataProvider>
        <Consumer id="a" />
        <Consumer id="b" />
      </StorageDataProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'add-a' }));

    await waitFor(() => {
      expect(screen.getByTestId('list-b')).toHaveTextContent('added-by-a');
    });
  });

  it('still renders its children when storage rejects', async () => {
    // The app holds someone's entire financial history and must open even
    // when a read fails. A provider that throws here white-screens the app.
    const storage = (await import('@/persistence/storage')).default;
    const spy = vi
      .spyOn(storage.exchanges, 'getAll')
      .mockRejectedValue(new Error('idb unavailable'));
    // The three expect()s below all still pass even with the provider's
    // try/catch removed, because React's synchronous render completes
    // before the rejection fires - that regression only used to surface as
    // a process-level unhandled rejection, not a red test. This
    // console.warn assertion is what turns "the catch block actually ran"
    // into an ordinary, always-red-when-broken assertion.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <StorageDataProvider>
        <div data-testid="child">rendered anyway</div>
      </StorageDataProvider>,
    );

    expect(await screen.findByTestId('child')).toBeInTheDocument();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to load exchanges',
        expect.any(Error),
      ),
    );

    spy.mockRestore();
    warnSpy.mockRestore();
  });

  it('throws a clear error when used outside the provider', () => {
    const Orphan = () => {
      useStorageData();
      return null;
    };
    expect(() => render(<Orphan />)).toThrow(/StorageDataProvider/);
  });

  it('re-arms the loading flag on a later reload, not just at mount', async () => {
    // loadingExchanges defaults to true, so a mount-only setState(true)
    // would look correct while never actually re-arming: a reload
    // triggered later by addExchange (or a future consumer's own
    // reloadExchanges() call) has to flip it true again too, or a spinner
    // bound to it would never reappear after the first load.
    render(
      <StorageDataProvider>
        <LoadingConsumer />
      </StorageDataProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('loading-exchanges')).toHaveTextContent('idle'),
    );

    const storage = (await import('@/persistence/storage')).default;
    let resolveGetAll: (value: unknown) => void = () => {};
    const getAllSpy = vi.spyOn(storage.exchanges, 'getAll').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGetAll = resolve;
        }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'reload' }));

    await waitFor(() =>
      expect(screen.getByTestId('loading-exchanges')).toHaveTextContent(
        'loading',
      ),
    );

    resolveGetAll([]);

    await waitFor(() =>
      expect(screen.getByTestId('loading-exchanges')).toHaveTextContent('idle'),
    );

    getAllSpy.mockRestore();
  });
});

describe('asset lists', () => {
  it('splits a newly added asset into fiat or crypto via the isFiat index, and addAsset reloads it in', async () => {
    render(
      <StorageDataProvider>
        <AssetsConsumer />
      </StorageDataProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('loading-assets')).toHaveTextContent('idle'),
    );

    await userEvent.click(screen.getByRole('button', { name: 'add-fiat' }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId('fiat-list')).getByText('test-fiat-xyz'),
      ).toBeInTheDocument(),
    );
    expect(
      within(screen.getByTestId('crypto-list')).queryByText('test-fiat-xyz'),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'add-crypto' }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId('crypto-list')).getByText('test-crypto-xyz'),
      ).toBeInTheDocument(),
    );
    expect(
      within(screen.getByTestId('fiat-list')).queryByText('test-crypto-xyz'),
    ).not.toBeInTheDocument();
  });

  it('discards BOTH lists, not just the failing one, when Promise.all rejects on reload', async () => {
    // reloadAssets fetches fiat and crypto with a single Promise.all: one
    // rejection means `nextAssets` is never assigned, so the `finally`
    // block leaves the previous state of BOTH lists in place - even the
    // half whose own fetch (getAllFiat) would have succeeded.
    render(
      <StorageDataProvider>
        <AssetsConsumer />
      </StorageDataProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('loading-assets')).toHaveTextContent('idle'),
    );

    const beforeFiat = screen.getByTestId('fiat-list').textContent;
    const beforeCrypto = screen.getByTestId('crypto-list').textContent;

    const storage = (await import('@/persistence/storage')).default;
    const fiatSpy = vi.spyOn(storage.assets, 'getAllFiat');
    const cryptoSpy = vi
      .spyOn(storage.assets, 'getAllCrypto')
      .mockRejectedValue(new Error('idb unavailable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await userEvent.click(
      screen.getByRole('button', { name: 'reload-assets' }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('assets-error')).toHaveTextContent(
        'idb unavailable',
      ),
    );
    expect(fiatSpy).toHaveBeenCalled();
    expect(cryptoSpy).toHaveBeenCalled();

    // Both lists are exactly what they were before the failed reload -
    // the successful getAllFiat result was discarded along with the
    // failing getAllCrypto one.
    expect(screen.getByTestId('fiat-list').textContent).toBe(beforeFiat);
    expect(screen.getByTestId('crypto-list').textContent).toBe(beforeCrypto);

    fiatSpy.mockRestore();
    cryptoSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('surfaced read errors', () => {
  it('populates exchangesError on a failed reload and clears it on the next successful one', async () => {
    render(
      <StorageDataProvider>
        <ExchangesErrorConsumer />
      </StorageDataProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('exchanges-error')).toHaveTextContent('none'),
    );

    const storage = (await import('@/persistence/storage')).default;
    const spy = vi
      .spyOn(storage.exchanges, 'getAll')
      .mockRejectedValueOnce(new Error('idb unavailable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await userEvent.click(
      screen.getByRole('button', { name: 'reload-exchanges' }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('exchanges-error')).toHaveTextContent(
        'idb unavailable',
      ),
    );

    // The mock only rejects once, so the next reload succeeds and must
    // clear the error rather than leaving it stuck forever.
    await userEvent.click(
      screen.getByRole('button', { name: 'reload-exchanges' }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('exchanges-error')).toHaveTextContent('none'),
    );

    spy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('putExchange', () => {
  it('updates an existing exchange in place instead of duplicating it, and every consumer sees the change', async () => {
    render(
      <StorageDataProvider>
        <PutExchangeConsumer />
      </StorageDataProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'seed' }));
    // Exchange.type is a required field, so addExchange writes 'Other' for
    // a wallet the user hasn't given a sync type to yet - not nothing.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('put-list')).getByText('renameable:Other'),
      ).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole('button', { name: 'rename' }));

    await waitFor(() =>
      expect(
        within(screen.getByTestId('put-list')).getByText('renamed:kraken'),
      ).toBeInTheDocument(),
    );
    expect(
      within(screen.getByTestId('put-list')).queryByText('renameable:Other'),
    ).not.toBeInTheDocument();
  });
});

describe('deleteExchange', () => {
  it('removes an exchange from storage and every consumer sees it disappear', async () => {
    // WalletRow used to bypass this provider entirely - a direct
    // storage.exchanges.delete() plus its own reloadExchanges() call -
    // which is exactly the kind of drift this provider exists to prevent
    // (see the module doc comment). deleteExchange follows addExchange/
    // putExchange's own shape: write, then reload.
    render(
      <StorageDataProvider>
        <DeleteExchangeConsumer />
      </StorageDataProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'seed' }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId('delete-list')).getByText('removable'),
      ).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole('button', { name: 'delete' }));

    await waitFor(() =>
      expect(
        within(screen.getByTestId('delete-list')).queryByText('removable'),
      ).not.toBeInTheDocument(),
    );

    const storage = (await import('@/persistence/storage')).default;
    const remaining: Exchange[] = await storage.exchanges.getAll();
    expect(remaining.some((e) => e.name === 'removable')).toBe(false);
  });
});
