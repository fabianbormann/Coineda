import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { resolveTokenMeta } from './tokenMetaStore';
import type { TokenMeta } from './tokenRegistry';

/**
 * Resolved Cardano token metadata, shared down the tree.
 *
 * A context rather than a prop: the thing that needs a logo is AssetIcon,
 * which renders deep inside rows, dialogs and tables, and threading a map
 * through every one of those would put a decoration into the signature of
 * every component between here and there.
 *
 * The default is an empty map, so every consumer renders correctly with no
 * provider at all - which is what keeps AssetIcon usable in a test, and
 * what makes an unreachable registry a no-op rather than a crash.
 */
const TokenMetaContext = createContext<Map<string, TokenMeta>>(new Map());

export const useTokenMetaMap = (): Map<string, TokenMeta> =>
  useContext(TokenMetaContext);

export const TokenMetaProvider = ({
  assetIds,
  children,
}: {
  assetIds: string[];
  children: React.ReactNode;
}) => {
  const [meta, setMeta] = useState<Map<string, TokenMeta>>(new Map());

  // Keyed on the sorted, de-duplicated ids rather than the array itself: the
  // caller builds this list inside a render, so a new array arrives on every
  // one of them and depending on the array would refetch forever.
  const key = useMemo(
    () => [...new Set(assetIds)].sort().join(','),
    [assetIds],
  );

  useEffect(() => {
    const ids = key === '' ? [] : key.split(',');
    if (ids.length === 0) {
      return;
    }
    const controller = new AbortController();
    let active = true;
    void resolveTokenMeta(ids, controller.signal).then((resolved) => {
      if (active && resolved.size > 0) {
        setMeta(resolved);
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [key]);

  return (
    <TokenMetaContext.Provider value={meta}>
      {children}
    </TokenMetaContext.Provider>
  );
};
