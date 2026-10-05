import { History, List, Pencil, RefreshCw, Square, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CryptoAmount } from '@/components/money/CryptoAmount';
import { Money } from '@/components/money/Money';
import type { Holding } from '@/ledger/balances';
import type { SourceRecord } from '@/ledger/types';

/**
 * What one source contributed to the ledger.
 *
 * `holdings` carries the source's PRICED positions, most valuable first,
 * and `unpricedCount` says how many were left out.
 *
 * Unpriced assets are excluded because a real Cardano wallet holds a long
 * tail of NFTs and airdropped tokens with no market price at all. Sorted by
 * asset id, as this row used to be, they crowd out the position that
 * matters: the owner's own wallet led with "1 APAVIA · 1 LACIE5113 ·
 * 1 LACIE5180 +38 more" and never showed its 507 ADA.
 *
 * Fiat is NOT excluded. It was once, to hide an exchange module emitting a
 * trade's euro leg without the deposit that funded it - but that only moved
 * the problem: the headline kept counting the artifact, so it and the sum
 * of its own sources differed by exactly that amount with nothing on screen
 * to explain it. The modules emit their fiat movements now, so a euro
 * balance here is real.
 *
 * Nothing is hidden either way. The count of unpriced assets sits beside
 * the figure, and every leg of every event is listed in the events dialog.
 */
export type PricedHolding = Holding & {
  /** This holding's worth in the base currency, as a decimal string. Kept
   *  rather than recomputed so the sort order and the figure on screen
   *  cannot disagree. */
  value: string;
};

export type SourceSummary = {
  eventCount: number;
  /** Priced, non-fiat, most valuable first. */
  holdings: PricedHolding[];
  /** Held assets with no price. Disclosed rather than silently dropped -
   *  the same rule the headline follows with its "n assets have no price"
   *  pill. */
  unpricedCount: number;
  /** Sum of `holdings`. Null only when nothing at all could be priced, so
   *  an empty figure never reads as a zero balance. */
  value: string | null;
};

/** Enough to tell a row at a glance what it holds; the rest is one click
 *  away in the events dialog, and a wallet with thirty dust tokens must not
 *  push the buttons off the card. */
const HOLDINGS_SHOWN = 3;

type Props = {
  source: SourceRecord;
  /** The module's own display label, already resolved by the caller via
   *  `findModule` - a source whose module is no longer in the registry
   *  falls back to the raw `moduleId` there, not here. */
  moduleLabel: string;
  /** Undefined only before the first fold, never for a source with no
   *  events - that case is a summary with `eventCount: 0`. */
  summary?: SourceSummary;
  /** The base currency `value` was priced in, passed down explicitly for
   *  the reason given on `Money`: a component rendering a number cannot
   *  know which currency produced it. */
  currency: string;
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
  /** Opens EditSourceDialog for this source. Gated by the same `busy` flag
   *  as Refresh/Resync/Remove - a sync that began before an edit opens must
   *  not race the record a save would write back. */
  onEdit: () => void;
  /**
   * Opens this source's own event log. Deliberately NOT gated by `busy`:
   * it reads the events already in memory and writes nothing, so there is
   * nothing for a sync in flight to race - and a row mid-sync is exactly
   * when a user wants to look at what it has recorded so far.
   */
  onShowEvents: () => void;
};

/**
 * One configured source. A failed sync renders its own diagnostic inline,
 * on this row only - the caller maps one `SourceRow` per source, so a
 * single broken row never prevents its siblings from rendering.
 */
export const SourceRow = ({
  source,
  moduleLabel,
  summary,
  currency,
  busy,
  syncing,
  onRefresh,
  onResync,
  onStop,
  onRemove,
  onEdit,
  onShowEvents,
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

  const eventCount = summary?.eventCount ?? 0;
  const holdings = summary?.holdings ?? [];
  const unpriced = summary?.unpricedCount ?? 0;
  const shown = holdings.slice(0, HOLDINGS_SHOWN);
  const hidden = holdings.length - shown.length;

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium">{source.label}</p>
          <p className="text-sm text-muted-foreground">{moduleLabel}</p>
          {(holdings.length > 0 || unpriced > 0) && (
            <p className="flex flex-wrap items-center gap-x-2 text-sm">
              {shown.map((holding, index) => (
                <span key={holding.assetId}>
                  {index > 0 && <span className="pr-2">·</span>}
                  <CryptoAmount
                    value={holding.amount}
                    assetId={holding.assetId}
                  />
                </span>
              ))}
              {hidden > 0 && (
                <span className="text-muted-foreground">
                  {t('+{{n}} more', { n: hidden })}
                </span>
              )}
              {summary?.value != null && (
                <span className="text-muted-foreground">
                  = <Money value={Number(summary.value)} currency={currency} />
                </span>
              )}
              {unpriced > 0 && (
                /* Disclosed rather than silently dropped. A wallet with a
                   long tail of NFTs would otherwise show a figure quietly
                   covering only part of what it holds. */
                <span className="text-muted-foreground">
                  {t('{{n}} without a price', { n: unpriced })}
                </span>
              )}
            </p>
          )}
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
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            disabled={eventCount === 0}
            onClick={onShowEvents}
            aria-label={t('Show events from {{label}}', {
              label: source.label,
            })}
          >
            <List aria-hidden="true" />
          </Button>
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
            onClick={onEdit}
            aria-label={t('Edit {{label}}', { label: source.label })}
          >
            <Pencil aria-hidden="true" />
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
