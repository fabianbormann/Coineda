import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { findModule } from '@/sources/registry';
import type { SourceRecord } from '@/ledger/types';
import { SourceRow } from './SourceRow';
import type { SourceSummary } from './SourceRow';

type Props = {
  sources: SourceRecord[];
  /** What each source contributed: how many events, what they fold to, and
   *  what that is worth. Computed once by MainScreen from the SAME owned-venue
   *  set as the headline figure - see the note on `perSource` there - rather
   *  than derived per row, so a transfer between two of the user's own
   *  sources cannot read as a disposal on one side. A source missing from
   *  the map simply has no summary yet. */
  perSource: Map<string, SourceSummary>;
  /** The base currency `perSource` values were priced in. Passed down
   *  explicitly rather than read from a context - see the note on `Money`. */
  currency: string;
  loadError: string | null;
  syncingAll: boolean;
  /** Every source id that must not be touched right now - mid per-row
   *  refresh, or (the whole of `sources`, since a bulk sync gives no
   *  per-item progress) mid "Sync all". Gates both the Refresh and the
   *  Remove button on each row; see the note in MainScreen.tsx. */
  busyIds: Set<string>;
  /** The subset of busyIds that is specifically mid-sync, so a row can
   *  offer Stop rather than a disabled spinner. */
  syncingIds: Set<string>;
  onRefreshAll: () => void;
  onRefreshOne: (source: SourceRecord) => void;
  /** Discard this source's events and cursor and drain it from the start -
   *  the only way to repair a row an ordinary re-drain now skips. Gated by
   *  the same `busyIds` as Refresh. */
  onResyncOne: (source: SourceRecord) => void;
  onStop: (source: SourceRecord) => void;
  onRemove: (source: SourceRecord) => void;
  onEditOne: (source: SourceRecord) => void;
  /** Opens the source's own event log. Read-only, so unlike every other
   *  per-row action it is not gated by `busyIds`. */
  onShowEvents: (source: SourceRecord) => void;
  onAddSource: () => void;
};

/**
 * The configured sources, with a header offering the two things this
 * screen's whole job revolves around: syncing what is already configured,
 * and adding more of it.
 *
 * A source list that fails to reload - `loadError` - renders its error
 * ALONGSIDE whatever list is already in state, never instead of it: `load`
 * in MainScreen never clears `sources` on a failed reload, so the
 * still-correct list is sitting right there, and a transient failure after
 * a sync/add/remove must not blank it down to just an error message. The
 * positive-sounding empty state ("No data sources yet") is suppressed
 * while there's a load error, though - with the load failing, this screen
 * genuinely doesn't know whether there are zero sources or the fetch simply
 * never came back, and claiming the former would be its own small lie.
 */
export const SourceList = ({
  sources,
  perSource,
  currency,
  loadError,
  syncingAll,
  busyIds,
  syncingIds,
  onRefreshAll,
  onRefreshOne,
  onResyncOne,
  onStop,
  onRemove,
  onEditOne,
  onShowEvents,
  onAddSource,
}: Props) => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('Data sources')}</h2>
        <div className="flex gap-2">
          {sources.length > 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={onRefreshAll}
              disabled={syncingAll || busyIds.size > 0}
            >
              <RefreshCw
                className={syncingAll ? 'animate-spin' : undefined}
                aria-hidden="true"
              />
              {t('Sync all')}
            </Button>
          )}
          <Button type="button" onClick={onAddSource}>
            {t('Add a data source')}
          </Button>
        </div>
      </div>

      {loadError && (
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
      )}

      {sources.length > 0 ? (
        <div className="flex flex-col gap-2">
          {sources.map((source) => {
            const module = findModule(source.moduleId);
            return (
              <SourceRow
                key={source.id}
                source={source}
                moduleLabel={
                  module ? t(module.manifest.label) : source.moduleId
                }
                summary={perSource.get(source.id)}
                currency={currency}
                busy={busyIds.has(source.id)}
                syncing={syncingIds.has(source.id)}
                onRefresh={() => onRefreshOne(source)}
                onResync={() => onResyncOne(source)}
                onStop={() => onStop(source)}
                onRemove={() => onRemove(source)}
                onEdit={() => onEditOne(source)}
                onShowEvents={() => onShowEvents(source)}
              />
            );
          })}
        </div>
      ) : (
        !loadError && (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
              <p className="font-medium">{t('No data sources yet')}</p>
              <p className="text-sm text-muted-foreground">
                {t(
                  'Add a data source to start building your balance automatically.',
                )}
              </p>
            </CardContent>
          </Card>
        )
      )}
    </div>
  );
};
