import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TriangleAlertIcon, Loader2Icon } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { taxRegistry } from '@/tax/registry';
import { runTaxReport } from '@/tax/runTaxReport';
import { buildDisclaimer, type Disclaimer } from '@/tax/disclaimer';
import { getSettings, putSettings } from '@/settings/settingsStore';
import { getAllEvents, getSources } from '@/ledger/db';
import {
  buildSourceDirectory,
  type SourceDirectoryEntry,
} from '@/tax/sourceDirectory';
import { compareAmounts, isZeroAmount, subtractAmounts } from '@/ledger/amount';
import { Money } from '@/components/money/Money';
import { symbolOf } from '@/components/money/asset';
import { CryptoAmount } from '@/components/money/CryptoAmount';
import { GainLoss } from '@/components/money/GainLoss';
import { formatFiat } from '@/components/money/format';
import type {
  TaxManifest,
  TaxModule,
  TaxReport,
  UnresolvedItem,
} from '@/tax/types';

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
 * The unresolved items, grouped by kind.
 *
 * Extracted so the screen and the printed page render the SAME rows from
 * the same data - the screen's filtered view and the document's complete
 * one differ in which items they are handed, and in nothing else. Inlining
 * it twice would have been two copies of the row markup, free to drift
 * until the paper said something the screen did not.
 *
 * `t` and `formatDate` are passed rather than taken from a hook, so this
 * stays a plain presentational component with no opinion about where the
 * locale comes from.
 */
const UnresolvedGroups = ({
  items,
  t,
  formatDate,
}: {
  items: UnresolvedItem[];
  t: (key: string, params?: Record<string, unknown>) => string;
  formatDate: (timestamp: number) => string;
}) => (
  <div className="flex flex-col gap-3">
    {groupByKind(items).map(([kind, group]) => (
      <div key={kind} className="flex flex-col gap-2">
        <p className="text-sm font-medium">
          {kindHeading(kind, t)} ({group.length})
        </p>
        {group.map((item, index) => (
          // The position within the group is part of the key:
          // resolveValues emits one item per TAX EVENT, and one ledger
          // event can produce several for the same asset (a net principal
          // leg and a fee leg of one transaction), so sourceEventId plus
          // assetId is not unique - the recorded report had 56 items and
          // 30 distinct keys, which let React drop rows the user is meant
          // to read. Each list is rendered from one finished assessment
          // and is never reordered within itself, so the position is
          // stable for as long as the key has to be.
          <Card key={`${item.sourceEventId}-${item.assetId}-${index}`}>
            <CardContent className="flex flex-col gap-1 text-sm">
              <p>
                {formatDate(item.timestamp)} · {item.venue} ·{' '}
                <CryptoAmount value={item.amount} assetId={item.assetId} />
              </p>
              <p className="text-destructive" role="alert">
                {t('Could not be computed: {{detail}}', {
                  detail: t(item.reason.key, item.reason.params),
                })}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    ))}
  </div>
);

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
export const TaxReportScreen = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  /**
   * Whether to hide unresolved items dated outside the tax year.
   *
   * ON by default, because the list is otherwise O(the whole ledger) and
   * grows every year forever: runTaxReport reads the entire history (it
   * must - a lot acquired years ago still has to match a disposal now) and
   * puts every unpriced or unclassified event from all of it into
   * `unresolved`, which it never filters by year. Only `omitted`, the
   * "N disposals could not be computed" figure, is year-scoped.
   *
   * An earlier version defaulted this OFF, on the reasoning that an
   * unpriced ACQUISITION from three years back is why an in-year disposal
   * has no cost basis, so hiding it would hide the explanation. That
   * reasoning was wrong: `match` runs on PRICED events only, so such a
   * disposal already gets its own `needs-cost-basis` item carrying the
   * DISPOSAL's timestamp - in-year, and visible either way. What the
   * out-of-year entry adds is which acquisition was unpriceable, which is
   * useful detail rather than the only trace of the problem.
   *
   * Nothing vanishes silently: the count of what is hidden is rendered
   * below, and one click brings it all back.
   */
  const [hideOutsideYear, setHideOutsideYear] = useState(true);

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
  const [assessment, setAssessment] = useState<TaxReport | null>(null);
  const [request, setRequest] = useState<RunRequest | null>(null);
  // The CoinGecko key, and what was loaded from settings, so the run only
  // writes it back when the user actually changed it - a failed settings
  // read must not let an empty input clobber a stored key.
  const [apiKey, setApiKey] = useState('');
  const [loadedApiKey, setLoadedApiKey] = useState('');
  // Who the printed sheet is for. Persisted on blur rather than on every
  // keystroke: this is a settings write per character otherwise, and the
  // value is only ever read back on the next mount.
  const [taxpayerName, setTaxpayerName] = useState('');
  const [taxNumber, setTaxNumber] = useState('');
  // Whether the settings read has landed. `persistTaxpayer` fires on blur,
  // and a blur can happen first - on a slow device, or permanently if the
  // read fails, which this screen deliberately does not treat as fatal.
  // Writing then would put two empty strings over a stored identity, and
  // putSettings replaces the taxpayer object wholesale rather than merging
  // into it. This is the same guard `loadedApiKey` exists for one field up.
  const [taxpayerLoaded, setTaxpayerLoaded] = useState(false);
  // Built alongside the report, not on mount: it describes the ledger the
  // figures were computed from, so it has to be read at the same moment
  // they were - a source added after a run would otherwise appear on a
  // sheet it contributed nothing to.
  const [sourceDirectory, setSourceDirectory] = useState<
    SourceDirectoryEntry[]
  >([]);

  // Settings are read once, on mount. This used to be a reset block keyed
  // on an `open` prop, re-running every time the dialog reopened; a screen
  // has no such prop, because navigating here mounts a fresh component and
  // navigating away unmounts it. The state this screen used to reset by
  // hand is simply never carried over now, which is the stronger version of
  // the same guarantee.
  useEffect(() => {
    let active = true;
    // Fire-and-forget: a settings read that fails leaves the EUR default in
    // place, the same fallback MainScreen uses, rather than blocking the
    // screen from rendering at all.
    void getSettings().then((settings) => {
      if (!active) {
        return;
      }
      setBaseCurrency(settings?.baseCurrency ?? DEFAULT_CURRENCY);
      setApiKey(settings?.coingeckoApiKey ?? '');
      setLoadedApiKey(settings?.coingeckoApiKey ?? '');
      setTaxpayerName(settings?.taxpayer?.name ?? '');
      setTaxNumber(settings?.taxpayer?.taxNumber ?? '');
      setTaxpayerLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);

  /** Written on blur, merging rather than replacing: the two fields have
   *  separate inputs and a write of one must not erase the other. */
  const persistTaxpayer = () => {
    if (!taxpayerLoaded) {
      return;
    }
    void putSettings({
      taxpayer: { name: taxpayerName, taxNumber },
    });
  };

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
  // check - never synchronously in the effect body - so a screen navigated
  // away from, or switched to another jurisdiction mid-run, cannot have the
  // abandoned result land in its state.
  //
  // Leaving the screen used to be a prop change (`open` going false) that
  // this effect depended on; it is an unmount now, and React runs the same
  // cleanup for it. The teardown is if anything more certain than before.
  useEffect(() => {
    if (!request) {
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
        const [sources, events] = await Promise.all([
          getSources(),
          getAllEvents(),
        ]);
        if (cancelled) {
          return;
        }
        setSourceDirectory(buildSourceDirectory(sources, events));
        setAssessment(result);
        setStatus('done');
      } catch (caught) {
        if (cancelled) {
          return;
        }
        // The screen stays put on failure, per the brief - a slow, failed
        // run (most likely the year being out of `supportedYears`, which
        // the thrown message already names) must not lose what the user
        // picked.
        setError(caught instanceof Error ? caught.message : String(caught));
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [request]);

  /**
   * Hands the report to the browser's print dialog, which is also where
   * "Save as PDF" lives on every platform this app runs on.
   *
   * No PDF library. One would mean re-describing a layout that already
   * exists in CSS, in a second dialect that cannot see the stylesheet - so
   * every change to the report would have to be made twice, and the two
   * would drift. The print rules in src/index.css do the work instead, and
   * what the person sees in the preview is the page itself.
   */
  const handlePrint = () => {
    // Guarded: jsdom has no print, and an Electron window without a print
    // handler would otherwise throw into the click.
    if (typeof window.print === 'function') {
      window.print();
    }
  };

  /**
   * The unresolved items as they are shown: optionally filtered to the tax
   * year, and always in date order.
   *
   * The year is read in UTC, matching the rest of this app - a local
   * reading can move an event across a year boundary, which is precisely
   * the boundary this filter is about.
   */
  const shownUnresolved = useMemo(() => {
    const items = assessment?.unresolved ?? [];
    const kept = hideOutsideYear
      ? items.filter(
          (item) =>
            new Date(item.timestamp).getUTCFullYear() === assessment?.year,
        )
      : [...items];
    return kept.sort((a, b) => a.timestamp - b.timestamp);
  }, [assessment, hideOutsideYear]);

  /**
   * How many unresolved items fall inside the tax year, out of all of them.
   *
   * Derived from the whole list rather than from what is on screen. That
   * happens to give the same number either way - filtering an already
   * year-filtered list by year changes nothing - so this is for clarity
   * rather than correctness: the count does not depend on the checkbox,
   * and reading it off the unfiltered list says so.
   *
   * What DOES keep the filter from hiding anything silently is the heading
   * itself, which carries `assessment.unresolved.length` whatever is being
   * shown.
   */
  const unresolvedInYear = (assessment?.unresolved ?? []).filter(
    (item) => new Date(item.timestamp).getUTCFullYear() === assessment?.year,
  ).length;

  const formatDate = (timestamp: number): string =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(
      new Date(timestamp),
    );

  return (
    // A page, not a dialog. The report is a long, wide document - per
    // disposal: a date, a venue, an amount, a cost basis, a gain and a
    // sentence of reasoning - and a dialog capped it at `sm:max-w-2xl`,
    // 672px, with everything past that clipped behind a horizontal
    // scrollbar. `min-w-0` is what actually lets the children shrink: a
    // flex item defaults to `min-width: auto`, so one long unbreakable
    // string inside would otherwise push the whole column wider than the
    // viewport instead of wrapping.
    // `p-6` to match MainScreen - the shell deliberately adds no padding of
    // its own, so each screen owns it, and this one shipped without any:
    // every line sat flush against the left edge of the viewport.
    //
    // `max-w-7xl` keeps the report off the far edge of a wide monitor
    // without putting it back in a dialog. The point of leaving the dialog
    // was 672px; 1280px is nearly twice what the widest report line needs.
    //
    // `min-w-0` is what actually lets the children shrink: a flex item
    // defaults to `min-width: auto`, so one long unbreakable string inside
    // would otherwise push the whole column wider than the viewport
    // instead of wrapping.
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-6 p-6">
      <div className="flex min-w-0 flex-col gap-4">
        {!module ? (
          <>
            <div className="flex flex-col gap-2">
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="-ml-2 w-fit text-muted-foreground"
              >
                <Link to="/">
                  <ArrowLeft aria-hidden="true" />
                  {t('Back to overview')}
                </Link>
              </Button>
              <h2 className="text-xl font-semibold">
                {t('Create tax report')}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t('Choose a jurisdiction')}
              </p>
            </div>
            {/* The picker is a short list of choices, not the report, so it
                gets its own narrow column rather than the page's width: a
                two-item list stretched across a 1280px page reads as a
                layout fault, which is what it looked like. The report
                below keeps the full width it was moved here for. */}
            <div className="flex w-full max-w-md flex-col gap-2">
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
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={goBack}
                className="-ml-2 w-fit text-muted-foreground print:hidden"
              >
                <ArrowLeft aria-hidden="true" />
                {t('Choose a jurisdiction')}
              </Button>
              <h2 className="text-xl font-semibold">
                {t(module.manifest.jurisdiction)}
              </h2>
              {/* Print only: the document's own header.
                  On screen the year, the base currency and the taxpayer are
                  all in the form below and the date is today. On paper none
                  of that is true - the sheet outlives the screen it came
                  from, and a reader at a tax office has to be able to
                  assign it to a file, date it, and see which software
                  produced it. A field left out silently reads as a field
                  that does not exist, so anything unstated prints as a
                  labelled blank the taxpayer can complete by hand. */}
              {assessment && (
                <div
                  data-testid="report-header"
                  className="hidden flex-col gap-1 print:flex"
                >
                  <p>
                    <span className="font-medium">{t('For')}: </span>
                    {taxpayerName || t('not stated')}
                    {' · '}
                    <span className="font-medium">{t('Tax number')}: </span>
                    {taxNumber || t('not stated')}
                  </p>
                  <p className="text-sm">
                    {t('Tax year')}: {assessment.year} ·{' '}
                    {t('Created on {{date}}', {
                      date: new Intl.DateTimeFormat(i18n.language, {
                        dateStyle: 'long',
                      }).format(new Date()),
                    })}
                    {' · '}Coineda {assessment.method.appVersion}
                  </p>
                  {/* Decided in UTC, matching taxYearOf: a local reading of
                      a late-December instant can report the wrong year, and
                      this notice is about exactly that boundary. */}
                  {assessment.year >= new Date().getUTCFullYear() && (
                    <p className="text-sm">
                      {t(
                        'Tax year {{year}} has not ended yet, so this is an interim figure.',
                        { year: assessment.year },
                      )}
                    </p>
                  )}
                  <p className="text-sm">
                    {t(
                      'This is a self-prepared report, not a certificate from a bank or an authority.',
                    )}
                  </p>
                </div>
              )}
            </div>

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
              {/* Controls for RUNNING the report, not statements about it.
                  These printed: an empty CoinGecko API-key box with its
                  help text, a tax-rate field and a year spinner, in the
                  middle of a document handed to a tax office. Nothing here
                  is lost on paper - the year, the base currency and the
                  taxpayer are all restated by the document header above. */}
              <div
                data-testid="report-form"
                className="flex flex-wrap gap-4 print:hidden"
              >
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
                <div className="flex flex-col gap-2">
                  <Label htmlFor="tax-report-taxpayer-name">
                    {t('Your name')}
                  </Label>
                  <Input
                    id="tax-report-taxpayer-name"
                    value={taxpayerName}
                    onChange={(event) => setTaxpayerName(event.target.value)}
                    onBlur={persistTaxpayer}
                    disabled={status === 'loading'}
                  />
                  <p className="text-sm text-muted-foreground">
                    {t(
                      'Shown on the printed report so it can be assigned to your file. Stored only on this device.',
                    )}
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="tax-report-tax-number">
                    {t('Tax number')}
                  </Label>
                  <Input
                    id="tax-report-tax-number"
                    value={taxNumber}
                    onChange={(event) => setTaxNumber(event.target.value)}
                    onBlur={persistTaxpayer}
                    disabled={status === 'loading'}
                  />
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

                {/* 1a. How the figures below were produced.
                    Above the totals, not in an appendix: a reader who has
                    not been told the matching method, its scope and the
                    price convention cannot check a single number further
                    down, and the first figure they meet is the one they
                    are most likely to act on. */}
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-semibold">
                    {t('How these figures were produced')}
                  </h3>
                  <Card>
                    <CardContent className="flex flex-col gap-1 text-sm">
                      <p>
                        <span className="font-medium">
                          {t('Matching method')}:{' '}
                        </span>
                        {assessment.method.matching === 'fifo'
                          ? t('First in, first out (FIFO)')
                          : t('Moving average')}
                      </p>
                      <p className="text-muted-foreground">
                        {t(assessment.method.partitionLabel)}
                      </p>
                      <p className="text-muted-foreground">
                        {t(
                          "Each event is valued at its asset's price on the UTC calendar day it happened, not at the price when this report was run.",
                        )}
                      </p>
                      <p>
                        <span className="font-medium">
                          {t('Price sources')}:{' '}
                        </span>
                        {assessment.method.priceSources.join(' · ')}
                      </p>
                      <p>
                        <span className="font-medium">
                          {t('Base currency')}:{' '}
                        </span>
                        {assessment.method.baseCurrency.toUpperCase()}
                        {' · '}
                        <span className="font-medium">
                          {t('Produced by')}:{' '}
                        </span>
                        Coineda {assessment.method.appVersion}
                      </p>
                      <p className="text-muted-foreground">
                        {t(
                          '{{count}} ledger events were considered; {{netted}} movements between your own wallets were netted out rather than treated as sales.',
                          {
                            count: assessment.method.eventsConsidered,
                            netted: assessment.method.internalTransfersNetted,
                          },
                        )}
                      </p>
                    </CardContent>
                  </Card>
                </div>

                {/* 1b. Which wallets and exchanges the figures came from.
                    A reader at a tax office has to be able to ask for the
                    statements behind a number, and cannot do that without
                    knowing which accounts produced it. Built from the
                    sources joined to their events - never from
                    SourceRecord.config, which is documented as possibly
                    holding credentials and must not reach a printed page. */}
                {sourceDirectory.length > 0 && (
                  <div
                    data-testid="source-directory"
                    className="flex flex-col gap-2"
                  >
                    <h3 className="text-sm font-semibold">
                      {t('Where these figures come from')}
                    </h3>
                    {sourceDirectory.map((entry) => (
                      <Card key={entry.sourceId ?? 'orphans'}>
                        <CardContent className="flex flex-col gap-1 text-sm">
                          <p className="font-medium">
                            {entry.sourceId === null
                              ? t(entry.label)
                              : entry.label}
                            {entry.moduleId !== null && (
                              <span className="ml-2 font-normal text-muted-foreground">
                                {entry.moduleId}
                              </span>
                            )}
                          </p>
                          {entry.venues.length > 0 && (
                            <p>
                              <span className="font-medium">
                                {t('Wallets and accounts')}:{' '}
                              </span>
                              {entry.venues.join(' · ')}
                            </p>
                          )}
                          <p className="text-muted-foreground">
                            {entry.firstAt !== undefined &&
                            entry.lastAt !== undefined
                              ? t('{{count}} events · {{from}} to {{to}}', {
                                  count: entry.eventCount,
                                  from: formatDate(entry.firstAt),
                                  to: formatDate(entry.lastAt),
                                })
                              : t('No events from this source yet')}
                          </p>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}

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
                        {/* The promise is conditional, because on screen it
                            is not always true: the filter below is ON by
                            default and hides every out-of-year item, which
                            is most of them. The recorded report said "65
                            ... each one is listed below" above a list
                            showing one. Print renders a complete list and
                            so always keeps the promise - but this sentence
                            is shared, so it has to be told which list it
                            sits above. */}
                        {t(
                          hideOutsideYear
                            ? '{{count}} other unresolved items are not disposals in this year'
                            : '{{count}} other unresolved items are not disposals in this year - each one is listed below',
                          {
                            count:
                              assessment.unresolved.length -
                              assessment.totals.omitted,
                          },
                        )}
                      </p>
                    )}
                    {/* A loss is not a zero. The figure above is what is
                        TAXED; this is what has to be declared to be usable
                        later, and the two were indistinguishable while both
                        printed as 0,00 EUR. */}
                    {!isZeroAmount(assessment.totals.loss) && (
                      <p>
                        <span className="font-medium">
                          {t('Loss to declare')}:{' '}
                        </span>
                        <Money
                          value={Number(assessment.totals.loss)}
                          currency={baseCurrency}
                        />
                        <span className="ml-2 text-sm text-muted-foreground">
                          {t(
                            'A loss only offsets later gains if you declare it, so it belongs in your return even though no tax is due on it.',
                          )}
                        </span>
                      </p>
                    )}
                    {/* Labelled by sign. The exempt side is a NET, so a
                        year whose long-held lots lost money puts a negative
                        number here - and the recorded report printed
                        "Steuerfreier Gewinn: -9,10 EUR", a contradiction in
                        terms sitting in a document filed with an authority. */}
                    <p>
                      <span className="font-medium">
                        {compareAmounts(assessment.totals.exemptGain, '0') < 0
                          ? t('Tax-free loss')
                          : t('Tax-free gain')}
                        :{' '}
                      </span>
                      <Money
                        value={Math.abs(Number(assessment.totals.exemptGain))}
                        currency={baseCurrency}
                      />
                    </p>
                    {/* "Taxable", not bare "Income": this figure is zero
                        once a Freigrenze applies, while the threshold block
                        below reports what was actually received. The two
                        read as a contradiction unless this one says which
                        of the pair it is. */}
                    <p>
                      <span className="font-medium">
                        {t('Taxable income')}:{' '}
                      </span>
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
                        {/* The jurisdiction's own words. This sentence used
                            to be written here and printed beside EVERY
                            figure - and Austria's is a statutory 27.5% KESt
                            with no caller-supplied rate, no surcharge, no
                            church tax and no progression to disclaim, so
                            all three clauses were false there. */}
                        {assessment.liabilityNote && (
                          <span className="ml-2 text-sm text-muted-foreground">
                            {t(assessment.liabilityNote)}
                          </span>
                        )}
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
                          {/* Supplied per threshold by the jurisdiction,
                              never written here. Germany returns TWO
                              thresholds - §23 private sales and §22 Nr. 3
                              staking income - and an unconditional note
                              told the reader that staking income consumed a
                              private-sale allowance. */}
                          {threshold.scopeNote && (
                            <p className="text-muted-foreground">
                              {t(threshold.scopeNote)}
                            </p>
                          )}
                          {threshold.exceeded ? (
                            <p className="font-medium text-destructive">
                              {t('Limit reached')}
                            </p>
                          ) : (
                            <p className="text-muted-foreground">
                              {t('Not reached · {{amount}} under the limit', {
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
                            {/* The symbol, not the raw id. This printed
                                "cardano:lovelace" beside every disposal -
                                the same defect CryptoAmount was changed to
                                prevent, surviving here because this line
                                shows an asset WITHOUT an amount and so
                                never went through it. */}
                            {formatDate(line.timestamp)} ·{' '}
                            {symbolOf(line.assetId)} ·{' '}
                            <CryptoAmount
                              value={line.amount}
                              assetId={line.assetId}
                            />{' '}
                            · {line.venue}
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
                          <p className="text-muted-foreground">
                            {t(line.reason.key, line.reason.params)}
                          </p>
                          {/* The lots behind the figures.
                              A holding period is a claim about WHEN
                              something was bought, and a report that states
                              the outcome without the date gives a reader
                              nothing to check it against - the single
                              reason the printed report was unusable to a
                              tax office.

                              Branching on the matching method is not
                              cosmetic. A moving-average jurisdiction's
                              `consumed` holds ONE synthetic lot whose
                              acquiredAt is the DISPOSAL's own timestamp and
                              whose heldDays is 0, because an averaged pool
                              has no acquisition date. Printing that as an
                              acquisition date would put a falsehood in a
                              document filed with an authority. */}
                          {assessment.method.matching === 'moving-average' ? (
                            <p className="text-muted-foreground">
                              {t(
                                'From pooled cost; an averaged holding has no single acquisition date.',
                              )}
                            </p>
                          ) : (
                            <ul className="flex flex-col gap-0.5 text-muted-foreground">
                              {line.consumed.map((lot, index) => (
                                <li key={`${lot.acquisitionEventId}-${index}`}>
                                  {t('Acquired {{date}}', {
                                    date: formatDate(lot.acquiredAt),
                                  })}{' '}
                                  ·{' '}
                                  <CryptoAmount
                                    value={lot.amount}
                                    assetId={line.assetId}
                                  />{' '}
                                  · {t('cost')}:{' '}
                                  <Money
                                    value={Number(lot.costBasis)}
                                    currency={baseCurrency}
                                  />{' '}
                                  ·{' '}
                                  {t('held {{days}} days', {
                                    days: lot.heldDays,
                                  })}
                                </li>
                              ))}
                            </ul>
                          )}
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
                      {/* The breakdown appears only when there is one to
                          make. With every item inside the year, "60 total,
                          60 in 2025" says the same thing twice. */}
                      {unresolvedInYear === assessment.unresolved.length
                        ? t(
                            'Not included in the figures above ({{count}} total)',
                            { count: assessment.unresolved.length },
                          )
                        : t(
                            'Not included in the figures above ({{total}} total, {{inYear}} in {{year}})',
                            {
                              total: assessment.unresolved.length,
                              inYear: unresolvedInYear,
                              year: assessment.year,
                            },
                          )}
                    </h3>

                    {/* Chronological within each kind. The list arrives in
                        whatever order the engine produced it, which for a
                        wallet's whole history is no order a reader can
                        follow. Hidden from the print: it is a control, and
                        what it hides is stated below it anyway. */}
                    <label className="flex w-fit items-center gap-2 text-sm text-muted-foreground print:hidden">
                      <input
                        type="checkbox"
                        checked={hideOutsideYear}
                        onChange={(changed) =>
                          setHideOutsideYear(changed.target.checked)
                        }
                        className="size-4 accent-current"
                      />
                      {t('Hide transactions outside the tax year')}
                    </label>
                    {/* Two lists, one source.
                        The screen's filter is a reading aid for a list that
                        can run to dozens of rows. The printed document must
                        carry every one of them: the heading right above
                        states a TOTAL, and the recorded report stated 65
                        while showing 1, because the checkbox was
                        `print:hidden` but its effect was not. A sheet that
                        contradicts itself about what it omitted is what
                        invites an estimate under §162 AO.

                        Both lists go through the same `UnresolvedGroups`
                        with the same data, so they can differ only in which
                        rows they include - never in what a row says. */}
                    <div
                      data-testid="unresolved-screen"
                      className="print:hidden"
                    >
                      <UnresolvedGroups
                        items={shownUnresolved}
                        t={t}
                        formatDate={formatDate}
                      />
                    </div>
                    <div
                      data-testid="unresolved-print"
                      className="hidden print:block"
                    >
                      <UnresolvedGroups
                        items={assessment.unresolved}
                        t={t}
                        formatDate={formatDate}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Sticky, because the report below runs for pages: the
                control that starts and re-runs it must not be a scroll away
                once a user has read down to the disposals.

                Only Run is disabled mid-run. Leaving is NOT: a real run
                takes minutes, one historical price lookup per disposal, and
                as a dialog this had Escape and a close button to abandon
                one. A screen has neither, so disabling both exits - as the
                first draft of this conversion did - left the only way out
                being the browser's own back button. The run's effect
                cleanup is what makes abandoning safe.

                `glass-chrome`, not `glass-2`: the report scrolls UNDER
                this bar, and a 55% film let its lines slide through as a
                blurred smear. `-mx-6 px-6` widens it back over the page's
                own padding - contained inside it, the two 24px gutters
                stayed uncovered and text scrolled past either side of the
                bar. `z-10` states what document order was already giving
                it, so a later positioned sibling cannot land on top. */}
            <div className="glass-chrome rim-t sticky bottom-0 z-10 -mx-6 flex flex-wrap gap-2 px-6 py-3 print:hidden">
              <Button type="button" variant="ghost" onClick={goBack}>
                {t('Back')}
              </Button>
              <Button
                type="button"
                onClick={handleRun}
                disabled={status === 'loading'}
              >
                {status === 'loading' ? t('Running…') : t('Run report')}
              </Button>
              {/* Only once there is something to print. A blank form sent
                  to a printer is pure waste, and the browser's own dialog
                  gives no hint that the page is empty. */}
              {assessment && (
                <Button type="button" variant="outline" onClick={handlePrint}>
                  <Printer aria-hidden="true" />
                  {t('Print or save as PDF')}
                </Button>
              )}
              <div className="flex-1" />
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate('/')}
              >
                {t('Back to overview')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
