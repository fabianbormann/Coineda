import { createContext, useCallback, useContext, useState } from 'react';
import { listClients, type ClientRecord } from './registry';

type ClientContextValue = {
  client: ClientRecord;
  readOnly: boolean;
  refresh: () => void;
  /** Switches the active client; App remounts everything below it. */
  switchTo: (id: string) => Promise<void>;
};

export const ClientContext = createContext<ClientContextValue | null>(null);

export const useClient = (): ClientContextValue => {
  const value = useContext(ClientContext);
  if (!value) throw new Error('useClient must be used inside a ClientProvider');
  return value;
};

/**
 * Hands the active client to the tree. `App` keys this on `client.id`, so a
 * switch remounts the onboarding gate and the router against the new
 * database. A rename keeps the id, so it only re-renders: `refresh` bumps a
 * tick and the record is re-read from the registry rather than trusted from
 * the (then stale) prop.
 */
export const ClientProvider = ({
  client,
  onChange,
  children,
}: {
  client: ClientRecord;
  onChange: (id: string) => Promise<void> | void;
  children: React.ReactNode;
}) => {
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const current = listClients().find((r) => r.id === client.id) ?? client;
  return (
    <ClientContext.Provider
      value={{
        client: current,
        readOnly: current.kind === 'review',
        refresh,
        switchTo: async (id) => {
          await onChange(id);
        },
      }}
    >
      {children}
    </ClientContext.Provider>
  );
};
