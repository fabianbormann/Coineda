import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { findModule } from '@/sources/registry';
import type { LedgerEvent, SourceRecord } from '@/ledger/types';
import { SourceRow } from './SourceRow';

type Props = {
  sources: SourceRecord[];
  events: LedgerEvent[];
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
  onStop: (source: SourceRecord) => void;
  onRemove: (source: SourceRecord) => void;
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
  events,
  loadError,
  syncingAll,
  busyIds,
  syncingIds,
  onRefreshAll,
  onRefreshOne,
  onStop,
  onRemove,
  onAddSource,
}: Props) => {
  const { t } = useTranslation();

  const eventCountBySource = new Map<string, number>();
  for (const event of events) {
    eventCountBySource.set(
      event.sourceId,
      (eventCountBySource.get(event.sourceId) ?? 0) + 1,
    );
  }

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
                eventCount={eventCountBySource.get(source.id) ?? 0}
                busy={busyIds.has(source.id)}
                syncing={syncingIds.has(source.id)}
                onRefresh={() => onRefreshOne(source)}
                onStop={() => onStop(source)}
                onRemove={() => onRemove(source)}
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
