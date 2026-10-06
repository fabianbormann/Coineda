import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  deleteSourceCascade,
  getEventsBySource,
  getSources,
} from '@/ledger/db';
import { foldHoldings, ownedVenuesOf } from '@/ledger/balances';
import { getLinkedEvents } from '@/ledger/manualLinks';
import { linkInternalTransfers, linkedEventIds } from '@/ledger/transfers';
import { proposeTransfers } from '@/ledger/proposeTransfers';
import { resolveSpotPrices, totalValue } from '@/prices/priceStore';
import { valueOf } from '@/prices/scale';
import { compareAmounts, sumAmounts } from '@/ledger/amount';
import { syncAll, syncSource } from '@/sync/syncSource';
import { getSettings } from '@/settings/settingsStore';
import { resetDevice } from '@/settings/resetDevice';
import { useConfirm } from '@/components/confirm/ConfirmProvider';
import { notify } from '@/lib/notify';
import { ExportCheckpointDialog } from '@/checkpoint/ExportCheckpointDialog';
import type { LedgerEvent, SourceRecord } from '@/ledger/types';
import { BalanceHeader } from './BalanceHeader';
import { SourceList } from './SourceList';
import type { PricedHolding, SourceSummary } from './SourceRow';
import { AddSourceDialog } from './AddSourceDialog';
import { EditSourceDialog } from './EditSourceDialog';
import { SourceEventsDialog } from './SourceEventsDialog';
import { JourneyDialog } from '@/journey/JourneyDialog';
import { ReviewTransfersDialog } from './ReviewTransfersDialog';
import { TokenMetaProvider } from '@/assets/TokenMetaContext';
import {
  EmptyArchiveError,
  importFile,
  textFromFile,
  UnknownFileFormatError,
} from '@/sources/csv/importFile';
import { fileRegistry } from '@/sources/csv/registry';

const DEFAULT_CURRENCY = 'eur';

type Props = {
  /**
   * Called once this device has actually been wiped, so the app can go
   * back to onboarding.
   *
   * A prop rather than something this screen does for itself: `App` owns
   * the `isOnboarded()` gate, and the screen that happens to host the
   * button is not the right place to decide what the app shows next. It
   * also means no page reload is needed to get there - this component
   * unmounts, and every piece of state it was holding about the ledger
   * goes with it.
   */
  onReset: () => void;
};

export const MainScreen = ({ onReset }: Props) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();

  const [sources, setSources] = useState<SourceRecord[]>([]);
  /** Kept from the pricing effect so a per-source figure is built from the
   *  same prices as the headline total, rather than fetched again. */
  const [prices, setPrices] = useState<Map<string, string>>(new Map());
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [total, setTotal] = useState(0);
  const [missingCount, setMissingCount] = useState(0);

  const [syncingAll, setSyncingAll] = useState(false);
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [resetting, setResetting] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  /** The source EditSourceDialog is currently open for. Kept separate from
   *  `sources` so a reload that lands while the dialog is open (another
   *  sync finishing, say) cannot swap out the record the dialog is mid-edit
   *  against. */
  const [editingSource, setEditingSource] = useState<SourceRecord | null>(null);
  /**
   * One AbortController per in-flight sync, so Stop can reach the request
   * that is actually running. A ref rather than state: aborting must not
   * depend on a re-render having happened, and the controllers are not
   * rendered.
   */
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [journeyDialogOpen, setJourneyDialogOpen] = useState(false);
  const [transfersDialogOpen, setTransfersDialogOpen] = useState(false);
  /** The source whose event log is open, or null. Doubles as the dialog's
   *  open flag: unlike the edit dialog there is nothing in flight to
   *  protect from a reload, so a second piece of state would only be
   *  another thing to keep in step. */
  const [eventsSource, setEventsSource] = useState<SourceRecord | null>(null);

  // Fetches only - no setState here, so this is safe to call directly from
  // the mount effect below without tripping react-hooks' rule against
  // calling a state-mutating function synchronously from an effect body.
  const fetchAll = useCallback(async () => {
    const [nextSources, nextEvents, settings] = await Promise.all([
      getSources(),
      getLinkedEvents(),
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
  // One owned-venue set for the whole screen. Ownership is a property of
  // the entire ledger, not of whichever slice is being folded, so the
  // headline, the per-source summaries and the event log must all use the
  // same one - deriving it per slice is what makes a transfer between two
  // of the user's own sources read as a disposal on one side.
  const ownedVenues = useMemo(() => ownedVenuesOf(events), [events]);

  /**
   * Movements that look like two halves of one transfer but share no
   * on-chain hash, usually because an exchange's export does not carry one.
   *
   * Computed here rather than inside the dialog so the button can say how
   * many there are, and so it can stay hidden when there are none - a
   * permanent "check your transfers" button that is almost always empty
   * teaches people to ignore it.
   */
  const transferProposals = useMemo(
    () =>
      proposeTransfers(
        events,
        ownedVenues,
        linkedEventIds(linkInternalTransfers(events, ownedVenues)),
      ),
    [events, ownedVenues],
  );

  const holdings = useMemo(
    () => foldHoldings(events, ownedVenues),
    [events, ownedVenues],
  );

  useEffect(() => {
    let active = true;
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
      setPrices(prices);
    });
    return () => {
      active = false;
    };
  }, [holdings, currency]);

  /**
   * Per source: its own events, what they add up to, and what that is worth.
   *
   * Folded from the SAME owned-venue set as the headline figure, not from
   * each source's own legs - a venue belongs to the user or it does not, and
   * deriving that per source would make a transfer between two of their own
   * sources look like a disposal on one side.
   */
  const perSource = useMemo(() => {
    const summary = new Map<string, SourceSummary>();
    for (const source of sources) {
      const own = events.filter((event) => event.sourceId === source.id);
      // Fiat is INCLUDED, exactly as the headline includes it.
      //
      // It used to be filtered out here, because an exchange module emitted
      // a trade's euro leg without ever emitting the deposit that funded
      // it, which made a source's folded euro balance minus everything ever
      // spent there. Filtering was the wrong fix: it hid the artifact on
      // the rows while the headline kept subtracting it, so the balance and
      // the sum of its own sources disagreed by exactly that amount -
      // EUR 3,770.00 on the owner's screen, with nothing to explain it.
      //
      // The artifact is gone at the source now (src/sources/bitpanda drains
      // the fiat route), so a euro balance here is a real one and belongs
      // on the row like any other holding. A module that emits trades
      // without their deposits will now show a visibly negative euro
      // balance, which is a bug report rather than a silent discrepancy.
      const held = foldHoldings(own, ownedVenues);

      // Priced and unpriced are separated here rather than in the row,
      // because the sort order depends on the figure: a real Cardano wallet
      // holds dozens of NFTs with no market price, and ordered by asset id
      // they bury the position that matters. Each holding carries the value
      // it was sorted by, so the order and the number on screen cannot
      // disagree.
      const priced: PricedHolding[] = [];
      let unpricedCount = 0;
      for (const holding of held) {
        const price = prices.get(holding.assetId);
        if (price === undefined) {
          unpricedCount += 1;
          continue;
        }
        priced.push({
          ...holding,
          value: valueOf(holding.amount, price, holding.assetId),
        });
      }
      // Descending, through the decimal comparator - Number() here would
      // collapse two dust positions that differ past 15 significant digits
      // into an arbitrary order.
      priced.sort((a, b) => compareAmounts(b.value, a.value));

      summary.set(source.id, {
        eventCount: own.length,
        holdings: priced,
        unpricedCount,
        // Summed from the same per-holding values the list is ordered by.
        // Null only when NOTHING could be priced, so a blank never reads as
        // a zero balance.
        value:
          priced.length === 0
            ? null
            : sumAmounts(priced.map((holding) => holding.value)),
      });
    }
    return summary;
  }, [events, sources, prices, ownedVenues]);

  /**
   * Every asset id anywhere on this screen, for the token registry to
   * resolve names and logos against.
   *
   * Taken from the EVENTS rather than from `holdings`, because a position
   * that nets to zero drops out of a fold while its events remain readable
   * in the per-source log - and a token the user has sold should not lose
   * its name there.
   */
  const assetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const event of events) {
      for (const leg of event.legs) {
        ids.add(leg.assetId);
      }
    }
    return [...ids];
  }, [events]);

  /**
   * Reads an exported file and writes what it holds into the ledger.
   *
   * The format is recognised from the file's own HEADER rather than from
   * its name - a user renames a download, and an importer run on the wrong
   * file produces plausible-looking garbage instead of a refusal.
   *
   * THROWS rather than reporting its own failure. The dialog that calls
   * this is showing the instructions for getting the right export, so a
   * complaint about the wrong one belongs on that screen, next to them -
   * not in a toast that slides away from it.
   */
  const handleImportFile = useCallback(
    async (file: File) => {
      let outcome;
      try {
        // Unpacks a zip on the way in. Kraken and the others deliver one,
        // and making a person extract it first is a step the app can take
        // for them - a plain CSV still goes straight through.
        outcome = await importFile(await textFromFile(file));
      } catch (error) {
        if (error instanceof EmptyArchiveError) {
          throw new Error(
            t(
              'That archive holds nothing Coineda can read. It contains: {{names}}',
              {
                names: error.names.join(', ') || '(nothing)',
              },
            ),
            { cause: error },
          );
        }
        if (error instanceof UnknownFileFormatError) {
          throw new Error(
            t('That is not a file Coineda recognises. It reads: {{formats}}', {
              formats: fileRegistry
                .map((module) => t(module.manifest.label))
                .join(', '),
            }),
            { cause: error },
          );
        }
        throw error;
      }

      await load();
      notify.success(
        t('Imported {{inserted}} new and {{updated}} updated from {{label}}', {
          inserted: outcome.inserted,
          updated: outcome.updated,
          label: t(outcome.module.manifest.label),
        }),
      );
      for (const skipped of outcome.skipped) {
        // Surfaced, not swallowed: a user whose balance looks short needs
        // to know which rows were left out and why.
        notify.info(skipped);
      }
    },
    [load, t],
  );

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
  // holds is `putSourceStatus` (src/ledger/db.ts), used for every status
  // write-back in src/sync/syncSource.ts: it checks, in the SAME
  // transaction as the write, that the source record still exists before
  // writing it back, so a sync that finishes after a removal already
  // committed is a no-op rather than a resurrection, regardless of what
  // this UI did or didn't disable.
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

  /**
   * Reports a successful sync, distinguishing "nothing NEW" from "nothing AT
   * ALL".
   *
   * A re-sync that finds nothing new is the normal, healthy case and gets a
   * plain success. A source that has produced no events whatsoever is a
   * different thing entirely, and saying "Synced" for it is what made a real
   * report read as a broken importer: a Bitcoin address with no history
   * synced cleanly and silently, and from the outside that is
   * indistinguishable from an importer that failed to parse anything.
   *
   * The count query only runs when the sync itself wrote nothing, so a
   * healthy source never pays for it.
   */
  const notifySynced = async (source: SourceRecord, wroteNothing: boolean) => {
    if (wroteNothing && (await getEventsBySource(source.id)).length === 0) {
      notify.warning(
        t('Synced {{label}}, but it has no events at all', {
          label: source.label,
        }),
      );
      return;
    }
    notify.success(t('Synced {{label}}', { label: source.label }));
  };

  const handleStop = (source: SourceRecord) => {
    // Abort the in-flight request directly. The sync itself notices, stops
    // between pages, and keeps everything that already committed - the
    // cursor is persisted per page, so stopping is not losing.
    controllersRef.current.get(source.id)?.abort();
  };

  const handleRefreshOne = async (source: SourceRecord) => {
    if (busyIds.has(source.id)) {
      return;
    }
    const controller = new AbortController();
    controllersRef.current.set(source.id, controller);
    setSyncingIds((prev) => new Set(prev).add(source.id));
    try {
      const report = await syncSource(source, { signal: controller.signal });
      if (report.cancelled) {
        // Not an error and not a success: the user asked for it. Saying so
        // beats silence, which would look like the Stop button did nothing.
        notify.info(t('Stopped syncing {{label}}', { label: source.label }));
      } else if (report.error) {
        // report.error is a raw provider diagnostic (see SyncReport in
        // src/sync/syncSource.ts) - framed in a translated sentence here.
        // The detail goes through t() too: a Cardano refusal throws a
        // translation key (CARDANO_MESSAGES), and t() returns any string it
        // has no key for unchanged, so one call covers both.
        notify.error(
          t('Could not sync {{label}}: {{detail}}', {
            label: source.label,
            detail: t(report.error),
          }),
        );
      } else {
        await notifySynced(
          source,
          report.inserted === 0 && report.updated === 0,
        );
      }
    } finally {
      controllersRef.current.delete(source.id);
      setSyncingIds((prev) => {
        const next = new Set(prev);
        next.delete(source.id);
        return next;
      });
      await load();
    }
  };

  /**
   * Re-download a source's whole history.
   *
   * The same path as Refresh - same busy gating, same AbortController, same
   * reporting - differing only in `full: true`, which discards this source's
   * derived events and resets its cursor before draining (see syncSource).
   * It exists because a plain refresh cannot repair every wrong row on disk:
   * `putEventsIfSourceExists` upserts on (sourceId, externalId), so a row
   * the module emits again IS corrected, but a transaction the module now
   * produces no legs for is skipped - and a skipped event is never updated
   * or deleted. A row recorded before the collateral and reference-input
   * fixes keeps its phantom disposal until something deletes it, and
   * `full: true` was reachable from nowhere in this UI.
   *
   * Confirmed first, because it throws away local state and re-issues the
   * source's entire request history against a provider that may rate-limit.
   */
  const handleResyncOne = async (source: SourceRecord) => {
    if (busyIds.has(source.id)) {
      return;
    }
    const proceed = await confirm({
      title: t('Resync {{label}} from scratch?', { label: source.label }),
      description: t(
        'This discards the events Coineda synced from {{label}} and downloads its whole history again. Events you added yourself stay. It can take a while and makes many requests to the provider.',
        { label: source.label },
      ),
      confirmLabel: t('Resync'),
      cancelLabel: t('Cancel'),
    });
    if (!proceed) {
      return;
    }

    const controller = new AbortController();
    controllersRef.current.set(source.id, controller);
    setSyncingIds((prev) => new Set(prev).add(source.id));
    try {
      const report = await syncSource(source, {
        full: true,
        signal: controller.signal,
      });
      if (report.cancelled) {
        notify.info(t('Stopped syncing {{label}}', { label: source.label }));
      } else if (report.error) {
        notify.error(
          t('Could not sync {{label}}: {{detail}}', {
            label: source.label,
            detail: t(report.error),
          }),
        );
      } else {
        notify.success(t('Resynced {{label}}', { label: source.label }));
      }
    } finally {
      controllersRef.current.delete(source.id);
      setSyncingIds((prev) => {
        const next = new Set(prev);
        next.delete(source.id);
        return next;
      });
      await load();
    }
  };

  const handleOpenEdit = (source: SourceRecord) => {
    if (busyIds.has(source.id)) {
      return;
    }
    setEditingSource(source);
    setEditDialogOpen(true);
  };

  /**
   * Runs after EditSourceDialog has already written the edited record -
   * this is the sync half only, not the save itself. `outcome.sync` is
   * EditSourceDialog's own decision (see `needsRedrain`/`hasCredentialChange`
   * there), made from comparing the normalised config against what was
   * stored:
   *
   * - `'none'` - only the label changed. No provider request is worth
   *   making for a rename, so this reloads the list (to show the new label)
   *   and stops - no busy gating, no AbortController, no sync at all.
   * - `'incremental'` - only a credential changed. An ordinary sync, same
   *   as Refresh: cheap, and lets the user see a corrected key start
   *   working.
   * - `'full'` - what the source fetches changed, so the drain restarts
   *   from scratch.
   *
   * No confirm here for the `'full'` case - EditSourceDialog already asked,
   * before the write this runs after. Same busy gating, same
   * AbortController-per-sync and same report handling as
   * handleRefreshOne/handleResyncOne for the two cases that do sync.
   */
  const handleEditOne = async (
    source: SourceRecord,
    outcome: { sync: 'none' | 'incremental' | 'full' },
  ) => {
    if (outcome.sync === 'none') {
      await load();
      return;
    }
    if (busyIds.has(source.id)) {
      return;
    }
    const full = outcome.sync === 'full';
    const controller = new AbortController();
    controllersRef.current.set(source.id, controller);
    setSyncingIds((prev) => new Set(prev).add(source.id));
    try {
      const report = await syncSource(source, {
        full,
        signal: controller.signal,
      });
      if (report.cancelled) {
        notify.info(t('Stopped syncing {{label}}', { label: source.label }));
      } else if (report.error) {
        notify.error(
          t('Could not sync {{label}}: {{detail}}', {
            label: source.label,
            detail: t(report.error),
          }),
        );
      } else if (full) {
        notify.success(t('Resynced {{label}}', { label: source.label }));
      } else {
        await notifySynced(
          source,
          report.inserted === 0 && report.updated === 0,
        );
      }
    } finally {
      controllersRef.current.delete(source.id);
      setSyncingIds((prev) => {
        const next = new Set(prev);
        next.delete(source.id);
        return next;
      });
      await load();
    }
  };

  const handleReset = async () => {
    const proceed = await confirm({
      title: t('Reset this device?'),
      // Spells out all three things it takes and that none of them are
      // recoverable, because none of that is guessable from the label and
      // there is no server-side copy to fall back on.
      description: t(
        'This deletes every data source, every transaction and every setting stored here, and starts over at the welcome screen. Nothing is stored anywhere else, so only a checkpoint you already created can bring it back.',
      ),
      confirmLabel: t('Reset everything'),
      cancelLabel: t('Cancel'),
      destructive: true,
    });
    if (!proceed) {
      return;
    }
    setResetting(true);
    try {
      await resetDevice();
      // Raised before handing over: `onReset` unmounts this screen, and
      // the onboarding flow that replaces it says nothing about where it
      // came from, so without this a confirmed reset and a crash back to
      // the welcome screen would look identical.
      notify.success(t('This device has been reset.'));
      onReset();
    } catch {
      notify.error(t('Could not reset this device. Try again.'));
      setResetting(false);
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
    // Wraps the whole screen so a logo resolved once is available to every
    // row, dialog and table under it - including the ones that mount later.
    <TokenMetaProvider assetIds={assetIds}>
      <div className="flex flex-col gap-6 p-6">
        <BalanceHeader
          total={total}
          currency={currency}
          missingCount={missingCount}
          lastSyncedAt={lastSyncedAt}
          assetCount={holdings.length}
          sourceCount={sources.length}
        />
        {/* Above the list, not below it. These act on the whole
            portfolio rather than on any one source, and a list that
            grows with every wallet pushed them off the bottom of the
            screen - so the two things a person comes here to do, a tax
            report and a checkpoint, were the hardest to reach. */}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setExportDialogOpen(true)}
          >
            {t('Create checkpoint')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate('/tax')}
          >
            {t('Create tax report')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setJourneyDialogOpen(true)}
          >
            {t('Create journey video')}
          </Button>
          {transferProposals.length > 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setTransfersDialogOpen(true)}
            >
              {t('Check {{count}} possible transfer', {
                count: transferProposals.length,
              })}
            </Button>
          )}
        </div>
        <SourceList
          sources={sources}
          perSource={perSource}
          currency={currency}
          loadError={loadError}
          syncingAll={syncingAll}
          busyIds={busyIds}
          syncingIds={syncingIds}
          onRefreshAll={handleRefreshAll}
          onRefreshOne={handleRefreshOne}
          onResyncOne={handleResyncOne}
          onStop={handleStop}
          onRemove={handleRemove}
          onEditOne={handleOpenEdit}
          onShowEvents={setEventsSource}
          onAddSource={() => setAddDialogOpen(true)}
        />
        <AddSourceDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
          onImportFile={handleImportFile}
          onCreated={async (created) => {
            setAddDialogOpen(false);
            await load();
            // Sync immediately. A source that sits there saying "Never
            // synced" until the user finds the refresh button is a source
            // that looks broken, and adding one is an unambiguous request
            // for its data.
            await handleRefreshOne(created);
          }}
        />
        <EditSourceDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          source={editingSource}
          onEdited={handleEditOne}
        />
        <ExportCheckpointDialog
          open={exportDialogOpen}
          onOpenChange={setExportDialogOpen}
        />
        <SourceEventsDialog
          open={eventsSource !== null}
          onOpenChange={(open) => {
            if (!open) {
              setEventsSource(null);
            }
          }}
          source={eventsSource}
          events={events}
          ownedVenues={ownedVenues}
        />
        <JourneyDialog
          open={journeyDialogOpen}
          onOpenChange={setJourneyDialogOpen}
        />
        {/* Last on the page, below the list and well away from the four
            "create" actions at the top: it is the only control here that
            destroys anything, and the one nobody should reach by aiming
            for something else. The sentence is not decoration - someone
            who reads only the button has no idea a checkpoint is the one
            thing that would have saved them. */}
        <div className="flex flex-col items-start gap-2 pt-2">
          <p className="text-sm text-muted-foreground">
            {t(
              'Deleting everything on this device starts it over at the welcome screen. Create a checkpoint first if you want any of it back.',
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            className="text-destructive"
            onClick={handleReset}
            disabled={resetting}
          >
            {t('Reset this device')}
          </Button>
        </div>
        <ReviewTransfersDialog
          open={transfersDialogOpen}
          onOpenChange={setTransfersDialogOpen}
          events={events}
          sources={sources}
          proposals={transferProposals}
          ownedVenues={ownedVenues}
          onConfirmed={load}
        />
      </div>
    </TokenMetaProvider>
  );
};
