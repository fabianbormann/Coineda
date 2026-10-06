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
import type { TransferProposal } from '@/ledger/proposeTransfers';
import { putManualLink } from '@/ledger/manualLinks';
import { notify } from '@/lib/notify';
import type { LedgerEvent, SourceRecord } from '@/ledger/types';
import { shortVenue } from './sourceEvents';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  events: LedgerEvent[];
  sources: SourceRecord[];
  /** Computed by the caller, which already shows their count on the button
   *  that opens this - computing them twice would let the badge and the
   *  list disagree. */
  proposals: TransferProposal[];
  ownedVenues: Set<string>;
  /** Called after a confirmation lands, so the caller can reload - the
   *  overlay is applied on read, so the pair only becomes a transfer once
   *  the log has been read again. */
  onConfirmed: () => void;
};

/**
 * Where a person tells Coineda that two movements were one.
 *
 * `linkInternalTransfers` pairs the two halves of a transfer on the
 * on-chain transaction hash, exactly, because this feeds a tax report. An
 * exchange that reports no hash leaves its half unpairable: Kraken's ledger
 * export carries its own ids, a time and an amount, and no hash or address
 * at all, so a withdrawal to the user's own wallet looks from the ledger
 * alone exactly like a sale.
 *
 * So the matching stays exact and the missing fact is supplied by the only
 * party who has it. Coineda proposes - same asset, opposite direction,
 * amounts a network fee apart, minutes or hours apart - and a confirmation
 * records the chain hash against the exchange row. From then on the
 * ordinary exact path does the work.
 *
 * Deliberately NOT automatic. Two movements of nearly the same size, close
 * in time, really can be a sale and an unrelated purchase, and silently
 * treating that as internal would delete a taxable disposal from the
 * report. A person can tell the difference; this list cannot.
 */
export const ReviewTransfersDialog = ({
  open,
  onOpenChange,
  events,
  sources,
  proposals,
  ownedVenues,
  onConfirmed,
}: Props) => {
  const { t, i18n } = useTranslation();
  const [saving, setSaving] = useState<string | null>(null);

  const byId = useMemo(
    () => new Map(events.map((event) => [event.id, event])),
    [events],
  );
  const sourceLabels = useMemo(
    () => new Map(sources.map((source) => [source.id, source.label])),
    [sources],
  );

  const formatTime = (timestamp: number): string =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestamp));

  const confirm = async (
    exchange: LedgerEvent,
    txHash: string,
    key: string,
  ) => {
    setSaving(key);
    try {
      await putManualLink({
        sourceId: exchange.sourceId,
        externalId: exchange.externalId,
        txHash,
      });
      onConfirmed();
      notify.success(t('Recorded as a transfer between your own venues.'));
    } catch {
      notify.error(t('Could not save that. Try again.'));
    } finally {
      setSaving(null);
    }
  };

  const sideOf = (event: LedgerEvent, assetId: string) => {
    const leg = netPrincipalLegs(event, ownedVenues).legs.find(
      (candidate) => candidate.assetId === assetId,
    );
    return { leg, label: sourceLabels.get(event.sourceId) ?? event.sourceId };
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('Check for internal transfers')}</DialogTitle>
          <DialogDescription>
            {t(
              'Some exchanges do not report the blockchain transaction behind a withdrawal, so Coineda cannot tell on its own that the money arrived in your own wallet. These pairs look like one movement. Confirming one records it as an internal transfer instead of a sale.',
            )}
          </DialogDescription>
        </DialogHeader>

        {proposals.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('Nothing to check - every transfer is already accounted for.')}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {proposals.map((proposal) => {
              const exchange = byId.get(proposal.unlinkedEventId);
              const chain = byId.get(proposal.chainEventId);
              if (!exchange || !chain) {
                return null;
              }
              const key = `${proposal.unlinkedEventId}-${proposal.chainEventId}-${proposal.assetId}`;
              const left = sideOf(exchange, proposal.assetId);
              const right = sideOf(chain, proposal.assetId);
              return (
                <Card key={key}>
                  <CardContent className="flex flex-col gap-2 text-sm">
                    {[left, right].map((side, index) => (
                      <div
                        key={index}
                        className="flex flex-wrap items-baseline gap-x-2"
                      >
                        {side.leg && (
                          <span
                            className={
                              side.leg.direction === 'in'
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-destructive'
                            }
                          >
                            {side.leg.direction === 'in' ? '+' : '−'}
                            <CryptoAmount
                              value={side.leg.amount}
                              assetId={side.leg.assetId}
                            />
                          </span>
                        )}
                        <span className="font-medium">{side.label}</span>
                        {side.leg && (
                          <span
                            className="text-muted-foreground"
                            title={side.leg.venue}
                          >
                            {shortVenue(side.leg.venue)}
                          </span>
                        )}
                      </div>
                    ))}
                    <p className="text-muted-foreground">
                      {formatTime(exchange.timestamp)} ·{' '}
                      {formatTime(chain.timestamp)}
                    </p>
                    <p className="text-muted-foreground">
                      {t('Difference')}:{' '}
                      <CryptoAmount
                        value={proposal.difference}
                        assetId={proposal.assetId}
                      />{' '}
                      {t('(the network fee, if these are the same movement)')}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        className="max-w-xs"
                        disabled={saving !== null}
                        onClick={() => confirm(exchange, proposal.txHash, key)}
                      >
                        {saving === key
                          ? t('Saving…')
                          : t('Yes, this is one transfer')}
                      </Button>
                    </div>
                    <p
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={proposal.txHash}
                    >
                      {proposal.txHash}
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
