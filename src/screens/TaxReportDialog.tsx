import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TriangleAlertIcon, Loader2Icon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { taxRegistry } from '@/tax/registry';
import { runTaxReport } from '@/tax/runTaxReport';
import { buildDisclaimer, type Disclaimer } from '@/tax/disclaimer';
import { getSettings, putSettings } from '@/settings/settingsStore';
import { subtractAmounts } from '@/ledger/amount';
import { Money } from '@/components/money/Money';
import { CryptoAmount } from '@/components/money/CryptoAmount';
import { GainLoss } from '@/components/money/GainLoss';
import { formatFiat } from '@/components/money/format';
import type {
  TaxAssessment,
  TaxManifest,
  TaxModule,
  UnresolvedItem,
} from '@/tax/types';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type Status = 'idle' | 'loading' | 'error' | 'done';

/**
 * One requested run, as data.
 *
 * The run happens in an effect keyed on this object rather than inside the
 * Run handler, which is what gives it a cleanup - the same `cancelled`-flag
 * shape JourneyDialog's series build uses. A real run takes minutes
 * (one historical price lookup per disposal) and only Back and Run are
 * disabled while it is in flight, so Escape and the close button can both
 * abandon one; without the guard the abandoned run's continuation landed
 * in the state a reopen had already reset, and a figure computed for one
 * jurisdiction rendered under another's heading, disclaimer and rate.
 *
 * It carries its own `module` rather than reading the `module` state: the
 * result must be matched against the jurisdiction it was computed FOR, not
 * whichever one happens to be selected when it resolves.
 */
type RunRequest = {
  module: TaxModule;
  year: number;
  baseCurrency: string;
  rate?: string;
  /**
   * The key to persist before running, when the input differs from what was
   * loaded. Persisted rather than passed: `resolveValues` reads it from
   * settings itself, and writing it first is what makes it reach the
   * provider on THIS run rather than the next one.
   */
  apiKey?: string;
};

const DEFAULT_CURRENCY = 'eur';

/** Translated wrapper text per UnresolvedItem.kind, so the raw `reason`
 *  (a diagnostic sentence, not a key - see UnresolvedItem in src/tax/types.ts)
 *  always lands inside a sentence that says what kind of gap it is, the
 *  same split SourceRow uses for `source.lastError`. */
const kindHeading = (
  kind: UnresolvedItem['kind'],
  t: (key: string) => string,
): string => {
  switch (kind) {
    case 'needs-cost-basis':
      return t('Disposals missing an acquisition');
    case 'needs-price':
      return t('Events missing a price');
    case 'unclassified':
      return t('Events this jurisdiction could not classify');
  }
};

// A plain module-level helper, not a hook or a component, so
// react-hooks/purity's render-purity check does not apply to it: it is
// never called during render, only from the `chooseModule` event handler
// below, which is exactly where a "what time is it right now" read belongs.
const buildDisclaimerNow = (manifest: TaxManifest) =>
  buildDisclaimer(manifest, Date.now());

const groupByKind = (
  items: UnresolvedItem[],
): [UnresolvedItem['kind'], UnresolvedItem[]][] => {
  const order: UnresolvedItem['kind'][] = [
    'needs-cost-basis',
    'needs-price',
    'unclassified',
  ];
  return order
    .map((kind): [UnresolvedItem['kind'], UnresolvedItem[]] => [
      kind,
      items.filter((item) => item.kind === kind),
    ])
    .filter(([, group]) => group.length > 0);
};

/**
 * The tax report screen: pick a jurisdiction from `taxRegistry`, pick a
 * year, optionally a personal rate, then run. Everything the engine (the
 * actual milestone - contract, matching, pricing, pipeline, Germany,
 * Austria) already computes is rendered honestly here, in a fixed order:
 * the disclaimer first and never dismissible, then the totals with
 * `omitted` welded on next to them, then thresholds, then the per-disposal
 * lines, then the unresolved items grouped by kind.
 *
 * `omitted` is deliberately rendered in the SAME paragraph as `taxableGain`
 * rather than as a sibling element, so a future edit cannot separate them
 * without visibly restructuring that one block - a plausible-looking total
 * that silently drops disposals is the one failure this screen exists to
 * prevent.
 */
export const TaxReportDialog = ({ open, onOpenChange }: Props) => {
  const { t, i18n } = useTranslation();

  const [module, setModule] = useState<TaxModule | null>(null);
  // Built once, when the jurisdiction is actually chosen (an event
  // handler, not render), because `buildDisclaimer` takes the current time
  // - calling Date.now() directly during render is an impure read that
  // react-hooks/purity correctly rejects.
  const [disclaimer, setDisclaimer] = useState<Disclaimer | null>(null);
  const [year, setYear] = useState(String(new Date().getUTCFullYear()));
  const [rate, setRate] = useState('');
  const [yearError, setYearError] = useState(false);
  const [baseCurrency, setBaseCurrency] = useState(DEFAULT_CURRENCY);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [assessment, setAssessment] = useState<TaxAssessment | null>(null);
  const [request, setRequest] = useState<RunRequest | null>(null);
  // The CoinGecko key, and what was loaded from settings, so the run only
  // writes it back when the user actually changed it - a failed settings
  // read must not let an empty input clobber a stored key.
  const [apiKey, setApiKey] = useState('');
  const [loadedApiKey, setLoadedApiKey] = useState('');

  // Reset to the jurisdiction picker every time the dialog is (re)opened -
  // the same "adjusting state when a prop changes" pattern AddSourceDialog
  // and ExportCheckpointDialog use, done during render rather than in a
  // useEffect so a stale report from a previous open can never flash first.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setModule(null);
      setDisclaimer(null);
      setYear(String(new Date().getUTCFullYear()));
      setRate('');
      setYearError(false);
      setStatus('idle');
      setError(null);
      setAssessment(null);
      // Dropping the request is what makes the in-flight run's effect
      // cleanup run, so a result still on its way cannot land in the state
      // this block just reset.
      setRequest(null);
      // Fire-and-forget: a settings read that fails leaves the EUR default
      // in place, the same fallback MainScreen uses, rather than blocking
      // the dialog from opening at all.
      void getSettings().then((settings) => {
        setBaseCurrency(settings?.baseCurrency ?? DEFAULT_CURRENCY);
        setApiKey(settings?.coingeckoApiKey ?? '');
        setLoadedApiKey(settings?.coingeckoApiKey ?? '');
      });
    }
  }

  const chooseModule = (next: TaxModule) => {
    setModule(next);
    setDisclaimer(buildDisclaimerNow(next.manifest));
    setStatus('idle');
    setError(null);
    setAssessment(null);
    // Switching jurisdiction abandons any run in flight, for the same
    // reason reopening does: its result was computed under different rules.
    setRequest(null);
  };

  const goBack = () => {
    setModule(null);
    setDisclaimer(null);
    setRequest(null);
  };

  const handleRun = () => {
    if (!module) {
      return;
    }
    const parsedYear = Number(year);
    if (!Number.isInteger(parsedYear)) {
      setYearError(true);
      return;
    }
    setYearError(false);
    setStatus('loading');
    setError(null);
    setAssessment(null);
    // A fresh object every time, so pressing Run again re-triggers the
    // effect below even with identical inputs.
    const trimmedKey = apiKey.trim();
    setRequest({
      module,
      year: parsedYear,
      baseCurrency,
      rate: rate.trim() === '' ? undefined : rate.trim(),
      apiKey: trimmedKey === loadedApiKey ? undefined : trimmedKey,
    });
  };

  // Runs the requested report. Every setState happens after an `await`,
  // inside the async run's own continuation and behind the `cancelled`
  // check - never synchronously in the effect body - so a dialog closed,
  // reopened or switched to another jurisdiction mid-run cannot have the
  // abandoned result land in its state. `open` is a dependency precisely
  // so closing the dialog tears the run's state write down.
  useEffect(() => {
    if (!open || !request) {
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        if (request.apiKey !== undefined) {
          // Awaited before the run, not fire-and-forget: resolveValues
          // reads the key from settings, so a write still in flight would
          // be a race the first run of a new key loses. An empty input
          // clears the stored key rather than storing ''.
          await putSettings({
            coingeckoApiKey: request.apiKey === '' ? undefined : request.apiKey,
          });
          if (cancelled) {
            return;
          }
          setLoadedApiKey(request.apiKey);
        }
        const result = await runTaxReport(request.module, {
          year: request.year,
          baseCurrency: request.baseCurrency,
          rate: request.rate,
        });
        if (cancelled) {
          return;
        }
        setAssessment(result);
        setStatus('done');
      } catch (caught) {
        if (cancelled) {
          return;
        }
        // Kept open on failure, per the brief - a slow, failed run (most
        // likely the year being out of `supportedYears`, which the thrown
        // message already names) must not lose whatever the user picked.
        setError(caught instanceof Error ? caught.message : String(caught));
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, request]);

  const formatDate = (timestamp: number): string =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(
      new Date(timestamp),
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {!module ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('Create tax report')}</DialogTitle>
              <DialogDescription>
                {t('Choose a jurisdiction')}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              {taxRegistry.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('No tax jurisdictions are available yet.')}
                </p>
              ) : (
                taxRegistry.map((candidate) => (
                  <Button
                    key={candidate.manifest.id}
                    type="button"
                    variant="outline"
                    className="justify-start"
                    onClick={() => chooseModule(candidate)}
                  >
                    {t(candidate.manifest.jurisdiction)}
                  </Button>
                ))
              )}
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t(module.manifest.jurisdiction)}</DialogTitle>
            </DialogHeader>

            {/* 1. The disclaimer, above everything else in this dialog, and
                not dismissible - no collapse, no close affordance of its
                own. */}
            {disclaimer && (
              <Card>
                <CardContent className="flex flex-col gap-2 text-sm">
                  <p>
                    {t('Written by {{contributor}}', {
                      contributor: disclaimer.contributor,
                    })}
                    {' · '}
                    {t('Rules last checked on {{date}}', {
                      date: new Intl.DateTimeFormat(i18n.language, {
                        dateStyle: 'medium',
                      }).format(Date.parse(disclaimer.rulesCheckedOn)),
                    })}
                  </p>
                  {disclaimer.stale && (
                    <p className="flex items-center gap-2 text-destructive">
                      <TriangleAlertIcon
                        className="size-4 shrink-0"
                        aria-hidden="true"
                      />
                      {t(
                        'These rules have not been checked in {{months}} months. Verify them yourself before relying on this report.',
                        { months: disclaimer.monthsSinceChecked },
                      )}
                    </p>
                  )}
                  <ul className="list-inside list-disc text-muted-foreground">
                    {disclaimer.references.map((reference) => (
                      <li key={reference}>{reference}</li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground">
                    {t(disclaimer.noticeKey)}
                  </p>
                </CardContent>
              </Card>
            )}

            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="tax-report-year">{t('Tax Year')}</Label>
                  <Input
                    id="tax-report-year"
                    type="number"
                    value={year}
                    aria-invalid={yearError || undefined}
                    onChange={(event) => setYear(event.target.value)}
                    disabled={status === 'loading'}
                  />
                  {yearError && (
                    <p className="text-sm text-destructive" role="alert">
                      {t('Enter a valid year')}
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="tax-report-rate">
                    {t('Your personal tax rate (optional)')}
                  </Label>
                  <Input
                    id="tax-report-rate"
                    inputMode="decimal"
                    placeholder="42"
                    value={rate}
                    onChange={(event) => setRate(event.target.value)}
                    disabled={status === 'loading'}
                  />
                  <p className="text-sm text-muted-foreground">
                    {t(
                      'A percentage, e.g. 42. Used only to estimate what you would owe - leave it empty to skip that figure.',
                    )}
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="tax-report-coingecko-key">
                    {t('CoinGecko API key')}
                  </Label>
                  {/* A credential: masked, and never put in a URL, a log or
                      an UnresolvedItem.reason. fetchHistoricalPrice sends it
                      only as the x-cg-demo-api-key header. */}
                  <Input
                    id="tax-report-coingecko-key"
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    disabled={status === 'loading'}
                  />
                  <p className="text-sm text-muted-foreground">
                    {t(
                      "Optional. Needed only to price tax events more than 365 days old - CoinGecko's free tier only covers the last year of history.",
                    )}
                  </p>
                </div>
              </div>

              {status === 'loading' && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2Icon
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                  {t(
                    'Running your tax report… this can take a while because historical prices are looked up one at a time.',
                  )}
                </div>
              )}

              {status === 'error' && error && (
                <p className="text-sm text-destructive" role="alert">
                  {t('Could not run the report: {{detail}}', {
                    detail: error,
                  })}
                </p>
              )}
            </div>

            {status === 'done' && assessment && (
              <div className="flex flex-col gap-4">
                <Separator />

                {/* 2. Totals, with `omitted` welded to `taxableGain` in the
                    same paragraph - see the class doc comment above. */}
                <Card>
                  <CardContent className="flex flex-col gap-2">
                    <p>
                      <span className="font-medium">{t('Taxable gain')}: </span>
                      <Money
                        value={Number(assessment.totals.taxableGain)}
                        currency={baseCurrency}
                      />
                      {assessment.totals.omitted > 0 && (
                        <span className="ml-2 inline-flex items-center gap-1 text-destructive">
                          <TriangleAlertIcon
                            className="size-4 shrink-0"
                            aria-hidden="true"
                          />
                          {t(
                            '{{count}} disposals could not be computed and are NOT included in this figure',
                            { count: assessment.totals.omitted },
                          )}
                        </span>
                      )}
                    </p>
                    {/* The remaining unresolved items, counted and named
                        separately rather than folded into the disposal
                        count above: an unpriced acquisition or native-token
                        leg is a real gap, but calling it a disposal that
                        could not be computed is what trained users to
                        ignore this warning - the recorded one-wallet report
                        showed 56 of them. */}
                    {assessment.unresolved.length - assessment.totals.omitted >
                      0 && (
                      <p className="text-sm text-muted-foreground">
                        {t(
                          '{{count}} other unresolved items are not disposals in this year - each one is listed below',
                          {
                            count:
                              assessment.unresolved.length -
                              assessment.totals.omitted,
                          },
                        )}
                      </p>
                    )}
                    <p>
                      <span className="font-medium">
                        {t('Tax-free gain')}:{' '}
                      </span>
                      <Money
                        value={Number(assessment.totals.exemptGain)}
                        currency={baseCurrency}
                      />
                    </p>
                    <p>
                      <span className="font-medium">{t('Income')}: </span>
                      <Money
                        value={Number(assessment.totals.income)}
                        currency={baseCurrency}
                      />
                    </p>
                    {assessment.estimatedLiability !== undefined && (
                      <p>
                        <span className="font-medium">
                          {t('Estimated tax liability')}:{' '}
                        </span>
                        <Money
                          value={Number(assessment.estimatedLiability)}
                          currency={baseCurrency}
                        />
                      </p>
                    )}
                  </CardContent>
                </Card>

                {/* 3. Threshold outcomes, including when not exceeded. */}
                {assessment.thresholds.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold">{t('Thresholds')}</h3>
                    {assessment.thresholds.map((threshold, index) => (
                      <Card key={`${threshold.label}-${index}`}>
                        <CardContent className="flex flex-col gap-1 text-sm">
                          <p className="font-medium">{t(threshold.label)}</p>
                          <p className="text-muted-foreground">
                            {threshold.kind === 'freigrenze'
                              ? t(
                                  'This is a Freigrenze: once the limit is reached, the entire gain becomes taxable, not just the excess.',
                                )
                              : t(
                                  'This is a Freibetrag: only the amount above the limit is taxed.',
                                )}
                          </p>
                          <p>
                            {t('Limit')}:{' '}
                            <Money
                              value={Number(threshold.limit)}
                              currency={baseCurrency}
                            />{' '}
                            · {t('Actual')}:{' '}
                            <Money
                              value={Number(threshold.actual)}
                              currency={baseCurrency}
                            />
                          </p>
                          {threshold.exceeded ? (
                            <p className="font-medium text-destructive">
                              {t('Limit reached')}
                            </p>
                          ) : (
                            <p className="text-muted-foreground">
                              {t('Not reached - {{amount}} under the limit', {
                                amount: formatFiat(
                                  Number(
                                    subtractAmounts(
                                      threshold.limit,
                                      threshold.actual,
                                    ),
                                  ),
                                  i18n.language,
                                  baseCurrency,
                                ),
                              })}
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}

                {/* 4. Per-disposal lines. */}
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-semibold">{t('Disposals')}</h3>
                  {assessment.lines.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t('No disposals in this year.')}
                    </p>
                  ) : (
                    assessment.lines.map((line) => (
                      <Card key={line.disposalEventId}>
                        <CardContent className="flex flex-col gap-1 text-sm">
                          <p className="font-medium">
                            {formatDate(line.timestamp)} · {line.assetId}
                          </p>
                          <p>
                            {t('Proceeds')}:{' '}
                            <Money
                              value={Number(line.proceeds)}
                              currency={baseCurrency}
                            />{' '}
                            · {t('Cost basis')}:{' '}
                            <Money
                              value={Number(line.costBasis)}
                              currency={baseCurrency}
                            />{' '}
                            · {t('Gain')}:{' '}
                            <GainLoss
                              value={Number(line.gain)}
                              currency={baseCurrency}
                            />
                          </p>
                          <p>
                            {t('Exempt')}:{' '}
                            <Money
                              value={Number(line.exempt)}
                              currency={baseCurrency}
                            />{' '}
                            · {t('Taxable')}:{' '}
                            <Money
                              value={Number(line.taxable)}
                              currency={baseCurrency}
                            />
                          </p>
                          <p className="text-muted-foreground">{line.reason}</p>
                        </CardContent>
                      </Card>
                    ))
                  )}
                </div>

                {/* 5. Unresolved items, grouped by kind, each reason shown
                    verbatim - never a resolution action, that is a later
                    milestone. */}
                {assessment.unresolved.length > 0 && (
                  <div className="flex flex-col gap-3">
                    <h3 className="text-sm font-semibold">
                      {t(
                        'Not included in the figures above ({{count}} total)',
                        { count: assessment.unresolved.length },
                      )}
                    </h3>
                    {groupByKind(assessment.unresolved).map(([kind, items]) => (
                      <div key={kind} className="flex flex-col gap-2">
                        <p className="text-sm font-medium">
                          {kindHeading(kind, t)} ({items.length})
                        </p>
                        {items.map((item, index) => (
                          // The position within the group is part of the
                          // key: resolveValues emits one item per TAX
                          // EVENT, and one ledger event can produce several
                          // for the same asset (a net principal leg and a
                          // fee leg of one transaction), so sourceEventId
                          // plus assetId is not unique - the recorded
                          // report had 56 items and 30 distinct keys, which
                          // let React drop rows the user is meant to read.
                          // The list is rendered from one finished
                          // assessment and is never reordered or filtered,
                          // so the position is stable for as long as the
                          // key has to be.
                          <Card
                            key={`${item.sourceEventId}-${item.assetId}-${index}`}
                          >
                            <CardContent className="flex flex-col gap-1 text-sm">
                              <p>
                                {formatDate(item.timestamp)} · {item.venue} ·{' '}
                                <CryptoAmount
                                  value={item.amount}
                                  assetId={item.assetId}
                                />
                              </p>
                              <p className="text-destructive" role="alert">
                                {t('Could not be computed: {{detail}}', {
                                  detail: item.reason,
                                })}
                              </p>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <DialogFooter className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={goBack}
                disabled={status === 'loading'}
              >
                {t('Back')}
              </Button>
              <Button
                type="button"
                onClick={handleRun}
                disabled={status === 'loading'}
              >
                {status === 'loading' ? t('Running…') : t('Run report')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
