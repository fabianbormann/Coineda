import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { deleteSourceCascade, getAllEvents, getSources } from '@/ledger/db';
import { foldHoldings } from '@/ledger/balances';
import { resolveSpotPrices, totalValue } from '@/prices/priceStore';
import { syncAll, syncSource } from '@/sync/syncSource';
import { getSettings } from '@/settings/settingsStore';
import { useConfirm } from '@/components/confirm/ConfirmProvider';
import { notify } from '@/lib/notify';
import { ExportCheckpointDialog } from '@/checkpoint/ExportCheckpointDialog';
import type { LedgerEvent, SourceRecord } from '@/ledger/types';
import { BalanceHeader } from './BalanceHeader';
import { SourceList } from './SourceList';
import { AddSourceDialog } from './AddSourceDialog';

const DEFAULT_CURRENCY = 'eur';

/**
 * Every leg's venue, trusted wholesale.
 *
 * There is no independent way to know, from the host side, which value a
 * module used for `leg.venue` - a chain module typically uses the
 * configured address, an exchange module whatever it can derive from its
 * own credentials, and the host never sees that mapping directly (see the
 * module contract in src/sources/types.ts: `fetchEvents` takes only
 * `config` and a cursor). Everything already sitting in this device's own
 * ledger came from this device's own configured sources or from the
 * user's own authored entries, so every venue it names is trusted as
 * owned. This is the same trust boundary `isInternalTransfer` already
 * leans on one leg at a time; here it is just applied to the whole log at
 * once to build the set foldHoldings needs.
 */
const ownedVenuesOf = (events: LedgerEvent[]): Set<string> => {
  const venues = new Set<string>();
  for (const event of events) {
    for (const leg of event.legs) {
      venues.add(leg.venue);
    }
  }
  return venues;
};

export const MainScreen = () => {
  const { t } = useTranslation();
  const confirm = useConfirm();

  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [total, setTotal] = useState(0);
  const [missingCount, setMissingCount] = useState(0);

  const [syncingAll, setSyncingAll] = useState(false);
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  // Fetches only - no setState here, so this is safe to call directly from
  // the mount effect below without tripping react-hooks' rule against
  // calling a state-mutating function synchronously from an effect body.
  const fetchAll = useCallback(async () => {
    const [nextSources, nextEvents, settings] = await Promise.all([
      getSources(),
      getAllEvents(),
      getSettings(),
    ]);
    return {
      sources: nextSources,
      events: nextEvents,
      currency: settings?.baseCurrency ?? DEFAULT_CURRENCY,
    };
  }, []);

  // Used by every action below (sync, remove, add) to refresh afterwards -
  // an ordinary async event-handler call, not an effect, so setState here
  // is unremarkable.
  const load = useCallback(async () => {
    try {
      const data = await fetchAll();
      setSources(data.sources);
      setEvents(data.events);
      setCurrency(data.currency);
      setLoadError(null);
    } catch {
      setLoadError(t('Could not load your data sources. Try again.'));
    }
  }, [fetchAll, t]);

  // The initial load. Deliberately not just `void load()`: the setState
  // calls live directly in this callback's own `.then`/`.catch`, the same
  // shape App.tsx's onboarding gate uses, rather than inside a separately
  // defined function that an unmount here could never cancel.
  useEffect(() => {
    let active = true;
    fetchAll()
      .then((data) => {
        if (!active) {
          return;
        }
        setSources(data.sources);
        setEvents(data.events);
        setCurrency(data.currency);
        setLoadError(null);
      })
      .catch(() => {
        if (active) {
          setLoadError(t('Could not load your data sources. Try again.'));
        }
      });
    return () => {
      active = false;
    };
  }, [fetchAll, t]);

  // Re-priced whenever the ledger or the base currency changes. Kept
  // separate from `load` so a currency-only change (none exist yet in this
  // milestone, but the model already supports it) would not need to
  // re-read the ledger to re-price it.
  useEffect(() => {
    let active = true;
    const holdings = foldHoldings(events, ownedVenuesOf(events));
    void resolveSpotPrices(
      holdings.map((holding) => holding.assetId),
      currency,
    ).then((prices) => {
      if (!active) {
        return;
      }
      const { total: nextTotal, missing } = totalValue(holdings, prices);
      setTotal(Number(nextTotal));
      setMissingCount(missing.length);
    });
    return () => {
      active = false;
    };
  }, [events, currency]);

  const lastSyncedAt = sources.reduce<number | null>((latest, source) => {
    if (source.lastSyncedAt === undefined) {
      return latest;
    }
    return latest === null
      ? source.lastSyncedAt
      : Math.max(latest, source.lastSyncedAt);
  }, null);

  // The single source of truth for "this source must not be touched right
  // now" - fed to both the per-row Refresh AND Remove buttons, AND to the
  // "Sync all" guard below. `syncAll` (src/sync/syncSource.ts) processes
  // `sources` sequentially and gives no per-item progress callback, so
  // there is no way to know which source it is on at any instant; every
  // source is therefore treated as busy for the whole bulk run, not just
  // the one currently in flight. `removingIds` covers the opposite trigger
  // order: a source whose own removal is in flight must also be busy, or
  // "Sync all" (or a per-row Refresh) fired at that moment would run
  // `syncAll`/`syncSource` over a stale `sources` snapshot that still
  // contains the record `deleteSourceCascade` is mid-deleting.
  //
  // This gating is a UI affordance, not the real guarantee - a user can
  // only click what the UI lets them click, but nothing stops two actions
  // from landing in whatever order anyway. The guarantee that actually
  // holds is `putSourceIfExists` in src/sync/syncSource.ts: every status
  // write-back there checks, in the SAME transaction as the write, that
  // the source record still exists before writing it back, so a sync that
  // finishes after a removal already committed is a no-op rather than a
  // resurrection, regardless of what this UI did or didn't disable.
  const busyIds = syncingAll
    ? new Set(sources.map((source) => source.id))
    : new Set([...syncingIds, ...removingIds]);

  const handleRefreshAll = async () => {
    if (syncingAll || syncingIds.size > 0 || removingIds.size > 0) {
      return;
    }
    setSyncingAll(true);
    try {
      const reports = await syncAll(sources);
      const failed = reports.filter((report) => report.error);
      if (failed.length === 0) {
        notify.success(t('Synced all sources'));
      } else {
        notify.error(t('Some sources failed to sync'));
      }
    } finally {
      setSyncingAll(false);
      await load();
    }
  };

  const handleRefreshOne = async (source: SourceRecord) => {
    if (busyIds.has(source.id)) {
      return;
    }
    setSyncingIds((prev) => new Set(prev).add(source.id));
    try {
      const report = await syncSource(source);
      if (report.error) {
        // report.error is a raw provider diagnostic (see SyncReport in
        // src/sync/syncSource.ts) - framed in a translated sentence here,
        // with the diagnostic itself kept verbatim as the detail.
        notify.error(
          t('Could not sync {{label}}: {{detail}}', {
            label: source.label,
            detail: report.error,
          }),
        );
      } else {
        notify.success(t('Synced {{label}}', { label: source.label }));
      }
    } finally {
      setSyncingIds((prev) => {
        const next = new Set(prev);
        next.delete(source.id);
        return next;
      });
      await load();
    }
  };

  const handleRemove = async (source: SourceRecord) => {
    if (busyIds.has(source.id)) {
      return;
    }
    const proceed = await confirm({
      title: t('Remove {{label}}?', { label: source.label }),
      description: t(
        'Removing {{label}} also deletes its synced events. Any events you added yourself stay.',
        { label: source.label },
      ),
      confirmLabel: t('Remove'),
      cancelLabel: t('Cancel'),
      destructive: true,
    });
    if (!proceed) {
      return;
    }
    // Marked busy from the moment the user actually confirmed - not
    // earlier, a mere pending confirmation must not block a sync - until
    // the cascade (success or failure) is done.
    setRemovingIds((prev) => new Set(prev).add(source.id));
    try {
      // One transaction spanning events, cursor and the source record - see
      // deleteSourceCascade's own doc comment in src/ledger/db.ts.
      await deleteSourceCascade(source.id);
      notify.success(t('{{label}} removed', { label: source.label }));
    } catch {
      notify.error(
        t('Could not remove {{label}}. Try again.', { label: source.label }),
      );
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(source.id);
        return next;
      });
      await load();
    }
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <BalanceHeader
        total={total}
        currency={currency}
        missingCount={missingCount}
        lastSyncedAt={lastSyncedAt}
      />
      <SourceList
        sources={sources}
        events={events}
        loadError={loadError}
        syncingAll={syncingAll}
        busyIds={busyIds}
        onRefreshAll={handleRefreshAll}
        onRefreshOne={handleRefreshOne}
        onRemove={handleRemove}
        onAddSource={() => setAddDialogOpen(true)}
      />
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={() => setExportDialogOpen(true)}
        >
          {t('Create checkpoint')}
        </Button>
      </div>
      <AddSourceDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onCreated={async () => {
          setAddDialogOpen(false);
          await load();
        }}
      />
      <ExportCheckpointDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
      />
    </div>
  );
};
