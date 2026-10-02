import { History, RefreshCw, Square, Trash2 } from 'lucide-react';
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
  /**
   * True while THIS source is syncing, as opposed to merely being busy
   * because something else is. The two are different buttons: a syncing row
   * offers Stop, a row that is busy for another reason offers nothing. A
   * single `busy` flag cannot express that, which is why a greyed-out
   * spinner with no way to cancel it was what users actually got.
   */
  syncing: boolean;
  onRefresh: () => void;
  /**
   * Re-download this source's whole history, discarding what is on disk.
   *
   * Needed because an ordinary refresh cannot repair every wrong row. A
   * re-drain upserts on (sourceId, externalId), so it does correct a row it
   * emits again - but a transaction the module now (correctly) produces no
   * legs for is SKIPPED rather than re-emitted, and a skipped event is
   * never updated or deleted. A row recorded before the collateral and
   * reference-input fixes could therefore keep a phantom disposal forever,
   * and `syncSource(source, { full: true })` was the only remedy while
   * nothing in the UI called it.
   */
  onResync: () => void;
  onStop: () => void;
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
  syncing,
  onRefresh,
  onResync,
  onStop,
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
              {/* The detail is run through t() as well as the wrapper.
                  Most of what reaches `lastError` is a raw provider
                  diagnostic, and t() hands any string it has no key for
                  straight back - but a Cardano refusal (see
                  CARDANO_MESSAGES) deliberately throws the translation KEY,
                  so a German user was shown the English sentence. Keying on
                  the English string is this project's whole i18n model, so
                  one t() serves both cases. */}
              {t('Sync failed: {{detail}}', { detail: t(source.lastError) })}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {syncing ? (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={onStop}
              aria-label={t('Stop syncing {{label}}', {
                label: source.label,
              })}
            >
              <Square aria-hidden="true" />
            </Button>
          ) : (
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
          )}
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={busy}
            onClick={onResync}
            aria-label={t('Resync {{label}} from scratch', {
              label: source.label,
            })}
          >
            <History aria-hidden="true" />
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
