import { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronsUpDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SettingsContext } from '@/SettingsContext';
import { useStorageData } from '@/components/data/StorageDataProvider';
import type { CoinedaAccount, CoinedaSettings } from '@/global/types';

/**
 * Sets the active account. Mirrors what AccountManagement did: the whole
 * account object into SettingsContext, and its NAME into
 * localStorage['activeAccount'], which is the key App.tsx's bootstrap reads.
 */
export const switchAccount = (
  account: CoinedaAccount,
  setSettings: (
    updater: (previous: CoinedaSettings) => CoinedaSettings,
  ) => void,
) => {
  setSettings((previous) => ({ ...previous, account }));
  try {
    localStorage.setItem('activeAccount', account.name);
  } catch {
    // ignore - the switch still applies for this session
  }
};

export const AccountSwitcher = () => {
  const { t } = useTranslation();
  const { settings, setSettings } = useContext(SettingsContext);
  // From the shared store, never a private fetch. This component mounts
  // once per app launch (AppShell is outside <Routes>), so a copy fetched
  // here would never see an account added, renamed or deleted on the
  // Settings page - and offering a deleted account here is what let a
  // dangling account id reach newly written transactions.
  const { accounts } = useStorageData();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('Switch account')}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <div
            className="size-7 shrink-0 rounded-md bg-sidebar-primary"
            style={{ filter: `hue-rotate(${settings.account.pattern}deg)` }}
            aria-hidden="true"
          />
          <span className="truncate font-medium group-data-[collapsible=icon]:hidden">
            {settings.account.name}
          </span>
          <ChevronsUpDown
            className="ml-auto size-4 shrink-0 opacity-60 group-data-[collapsible=icon]:hidden"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {accounts.map((account) => (
          <DropdownMenuItem
            key={account.id}
            onSelect={() => switchAccount(account, setSettings)}
          >
            <div
              className="size-4 shrink-0 rounded bg-primary"
              style={{ filter: `hue-rotate(${account.pattern}deg)` }}
              aria-hidden="true"
            />
            <span className="truncate">{account.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
