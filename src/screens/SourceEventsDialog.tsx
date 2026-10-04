import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CryptoAmount } from '@/components/money/CryptoAmount';
import { netPrincipalLegs } from '@/ledger/balances';
import type { EventKind, LedgerEvent, SourceRecord } from '@/ledger/types';
import { EVENT_PAGE, shortVenue } from './sourceEvents';

/**
 * An event kind in words.
 *
 * Typed as a total `Record<EventKind, string>` on purpose: adding a kind to
 * the union then fails to compile here rather than rendering the raw
 * identifier to the user. The values are English sentences because that is
 * this project's i18n model - the key IS the English string (see
 * src/i18n.js), so each of these needs a matching entry in de.json.
 */
const KIND_LABELS: Record<EventKind, string> = {
  trade: 'Trade',
  transfer: 'Transfer',
  reward: 'Reward',
  fee: 'Fee',
  'fiat-in': 'Deposit',
  'fiat-out': 'Withdrawal',
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Stays nullable rather than asserted non-null: a dialog that outlives
   *  the row it was opened for - the source gets removed while this is open
   *  - should fail closed, not crash. The same choice EditSourceDialog makes. */
  source: SourceRecord | null;
  /** Every event in the ledger. Filtered to this source here rather than
   *  re-queried: MainScreen already holds the whole log in memory to fold
   *  the balance from, so a second read would only risk disagreeing with
   *  the figure on the row that opened this. */
  events: LedgerEvent[];
  /** The owned-venue set the balance was folded with, passed in for the
   *  same reason `perSource` uses it: ownership is a property of the whole
   *  ledger, and deriving it from one source's legs would net a transfer
   *  between two of the user's own sources to nothing on one side. */
  ownedVenues: Set<string>;
};

/**
 * One source's own event log.
 *
 * Shows each event NETTED per asset, through the very same
 * `netPrincipalLegs` the tax engine runs on, rather than its raw legs. Not
 * for brevity: a UTXO transaction's raw legs are its inputs and change
 * outputs, so a payment of 102 appears as `out 500` and `in 398`, and a
 * user reading that cannot see what the transaction did to their position.
 * Netting with the engine's own function also means what this dialog shows
 * is what the tax report acted on - if the two disagreed, the dialog would
 * be a false alibi for a wrong report.
 */
export const SourceEventsDialog = ({
  open,
  onOpenChange,
  source,
  events,
  ownedVenues,
}: Props) => {
  const { t, i18n } = useTranslation();
  const [shown, setShown] = useState(EVENT_PAGE);

  const own = useMemo(() => {
    if (source === null) {
      return [];
    }
    return events
      .filter((event) => event.sourceId === source.id)
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [events, source]);

  const formatTime = (timestamp: number): string =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestamp));

  const page = own.slice(0, shown);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Paging resets on close rather than on open: resetting on open
        // would fight the mount, and leaving it would have a reopened
        // dialog render a thousand rows it was never asked for.
        if (!next) {
          setShown(EVENT_PAGE);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{source?.label ?? t('Events')}</DialogTitle>
          <DialogDescription>
            {t('{{count}} events', { count: own.length })}
          </DialogDescription>
        </DialogHeader>

        {own.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('This source has not recorded any events yet.')}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {page.map((event) => {
              const netted = netPrincipalLegs(event, ownedVenues);
              return (
                <Card key={event.id}>
                  <CardContent className="flex flex-col gap-1 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">
                        {t(KIND_LABELS[event.kind])}
                      </span>
                      <span className="text-muted-foreground">
                        {formatTime(event.timestamp)}
                      </span>
                    </div>
                    {netted.legs.length === 0 ? (
                      // A fully netted-out event: every asset came back to
                      // an owned venue. Saying so beats an empty card, which
                      // reads as a rendering bug.
                      <p className="text-muted-foreground">
                        {t('Moved between your own venues')}
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-0.5">
                        {netted.legs.map((leg, index) => (
                          <li
                            key={`${leg.assetId}-${leg.role}-${index}`}
                            className="flex flex-wrap items-baseline gap-x-2"
                          >
                            <span
                              className={
                                leg.direction === 'in'
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-destructive'
                              }
                            >
                              {leg.direction === 'in' ? '+' : '−'}
                              <CryptoAmount
                                value={leg.amount}
                                assetId={leg.assetId}
                              />
                            </span>
                            <span
                              className="text-muted-foreground"
                              title={leg.venue}
                            >
                              {shortVenue(leg.venue)}
                            </span>
                            {leg.role === 'fee' && (
                              <span className="text-muted-foreground">
                                {t('network fee')}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {event.note && (
                      <p className="text-muted-foreground">{event.note}</p>
                    )}
                    <p
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={event.externalId}
                    >
                      {event.externalId}
                    </p>
                  </CardContent>
                </Card>
              );
            })}
            {own.length > page.length && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setShown((current) => current + EVENT_PAGE)}
              >
                {t('Show {{n}} more', {
                  n: Math.min(EVENT_PAGE, own.length - page.length),
                })}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
