import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';
import { Loader2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { notify } from '@/lib/notify';
import storage from '@/persistence/storage';
import { useStorageData } from '@/components/data/StorageDataProvider';
import type { Token } from '@/global/types';

const COIN_LIST_URL = 'https://api.coingecko.com/api/v3/coins/list';
const CACHE_KEY = 'TOKEN_LIST';
const CACHE_TTL_MS = 1000 * 60 * 15;

/** The full CoinGecko coin list is large and changes rarely, so it is cached
 *  for 15 minutes. Without it every search is a full-list download. */
const loadCoinList = async (): Promise<Token[]> => {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const { entries, age } = JSON.parse(cached);
      if (Date.now() - age < CACHE_TTL_MS) return entries;
    }
  } catch {
    // ignore a bad or unavailable cache and refetch
  }

  const response = await axios.get(COIN_LIST_URL);
  const entries: Token[] = response.data;
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ entries, age: Date.now() }),
    );
  } catch {
    // ignore - the search still works without a cache
  }
  return entries;
};

export const AssetSearch = () => {
  const { t } = useTranslation();
  const { addAsset } = useStorageData();
  const [symbol, setSymbol] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Token[] | null>(null);

  const search = async () => {
    const query = symbol.trim();
    if (query.length < 2) return;

    setSearching(true);
    try {
      const coins = await loadCoinList();
      const matches = coins.filter(
        (coin) => coin.symbol.toLowerCase() === query.toLowerCase(),
      );
      setResults(matches);
    } catch (error) {
      console.warn(error);
      setResults(null);
      notify.error(t('Unable to reach CoinGecko. Please try again later.'));
    } finally {
      setSearching(false);
    }
  };

  const add = async (coin: Token) => {
    try {
      // storage.assets.add lowercases the id on write, so look up the same
      // way - the old code did not, so a mixed-case id missed the check and
      // then failed the unique constraint.
      const existing = await storage.assets.get(coin.id.toLowerCase());
      if (existing) {
        notify.info(
          t('{{name}} is already in your asset list', { name: coin.name }),
        );
        return;
      }
      // `name` is passed through so a user-added asset is the same shape as
      // the seeded ones. No `isFiat`: storage.assets.add derives it from the
      // presence of `roughly_estimated_in_euro` and overwrites anything a
      // caller passes.
      await addAsset({ id: coin.id, symbol: coin.symbol, name: coin.name });
      notify.success(
        t('Added {{name}} to your asset list', { name: coin.name }),
      );
      setResults(null);
      setSymbol('');
    } catch (error) {
      console.warn(error);
      notify.error(
        t('Asset persistence failed. Please restart the application.'),
      );
    }
  };

  return (
    <div className="grid gap-4">
      {/* A real form, so Enter and the button take the same path. The old
          code hand-rolled a keydown check against `event.code === '13'`,
          which never matches. */}
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <div className="grid flex-1 gap-2">
          <Label htmlFor="asset-symbol">{t('Symbol')}</Label>
          <Input
            id="asset-symbol"
            value={symbol}
            placeholder={t('Asset input placeholder')}
            onChange={(event) => setSymbol(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={searching || symbol.trim().length < 2}>
          {searching ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Search className="size-4" aria-hidden="true" />
          )}
          {t('Search')}
        </Button>
      </form>

      {results !== null && results.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t('Found no coin with that symbol')}
        </p>
      )}

      {results !== null && results.length > 0 && (
        <ul className="grid gap-2">
          {results.map((coin) => (
            <li
              key={coin.id}
              className="flex items-center gap-3 rounded-md border border-border p-3"
            >
              <span className="font-medium">{coin.name}</span>
              <span className="text-sm text-muted-foreground uppercase">
                {coin.symbol}
              </span>
              <Button
                className="ml-auto"
                size="sm"
                onClick={() => void add(coin)}
              >
                {t('Add')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
