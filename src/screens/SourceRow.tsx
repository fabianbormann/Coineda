import { RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { SourceRecord } from '@/ledger/types';

type Props = {
  source: SourceRecord;
  /** The module's own display label, already resolved by the caller via
   *  `findModule` - a source whose module is no longer in the registry
   *  falls back to the raw `moduleId` there, not here. */
  moduleLabel: string;
  eventCount: number;
  /** True while this source must not be touched - its own refresh is in
   *  flight, or a bulk "Sync all" is running (which, since it gives no
   *  per-item progress, treats every source as busy for its whole
   *  duration). Disables BOTH the refresh and the remove button: removing
   *  a source a sync hasn't reached yet would have that sync resurrect it
   *  by writing back `putSource(...)` once it got there. */
  busy: boolean;
  onRefresh: () => void;
  onRemove: () => void;
};

/**
 * One configured source. A failed sync renders its own diagnostic inline,
 * on this row only - the caller maps one `SourceRow` per source, so a
 * single broken row never prevents its siblings from rendering.
 */
export const SourceRow = ({
  source,
  moduleLabel,
  eventCount,
  busy,
  onRefresh,
  onRemove,
}: Props) => {
  const { t, i18n } = useTranslation();

  const lastSyncedLabel = source.lastSyncedAt
    ? t('Last synced {{time}}', {
        time: new Intl.DateTimeFormat(i18n.language, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(source.lastSyncedAt)),
      })
    : t('Never synced');

  const statusLabel = source.lastError
    ? t('Sync failed')
    : source.lastSyncedAt
      ? t('Synced')
      : t('Not yet synced');

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium">{source.label}</p>
          <p className="text-sm text-muted-foreground">{moduleLabel}</p>
          <p className="text-sm text-muted-foreground">
            {statusLabel} · {lastSyncedLabel} ·{' '}
            {t('{{count}} events', { count: eventCount })}
          </p>
          {source.lastError && (
            <p className="text-sm text-destructive" role="alert">
              {t('Sync failed: {{detail}}', { detail: source.lastError })}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={busy}
            onClick={onRefresh}
            aria-label={t('Refresh {{label}}', { label: source.label })}
          >
            <RefreshCw
              className={busy ? 'animate-spin' : undefined}
              aria-hidden="true"
            />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={busy}
            onClick={onRemove}
            aria-label={t('Remove {{label}}', { label: source.label })}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
