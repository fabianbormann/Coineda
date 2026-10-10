import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TriangleAlertIcon, Loader2Icon } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { DatevSettingsCard } from '@/datev/DatevSettingsCard';
import {
  buchungsstapel,
  datevFilename,
  postingsFromReport,
  validateDatevSettings,
  type DatevSettingsIssue,
} from '@/datev/buchungsstapel';
import { encodeCp1252 } from '@/datev/cp1252';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import markBlack from '@/assets/logo/coineda-mark-black.svg';
import { findModule } from '@/sources/registry';
import { taxRegistry } from '@/tax/registry';
import { runTaxReport } from '@/tax/runTaxReport';
import { registerFilename, registerToCsv, reportToJson } from '@/tax/register';
import { describePriceSource } from '@/components/money/priceSource';
import { REWARD_KIND_LABELS } from '@/tax/rewardKinds';
import { DERIVATIVE_KIND_LABELS } from '@/tax/derivativeKinds';
import { buildDisclaimer, type Disclaimer } from '@/tax/disclaimer';
import {
  getSettings,
  putSettings,
  type DatevSettings,
} from '@/settings/settingsStore';
import { ClientContext } from '@/clients/ClientContext';
import { labelOf, listClients } from '@/clients/registry';
import { shortFingerprint } from '@/ledger/fingerprint';
import { activeLedgerName, getAllEvents, getSources } from '@/ledger/db';
import {
  buildSourceDirectory,
  type SourceDirectoryEntry,
} from '@/tax/sourceDirectory';
import {
  addAmounts,
  compareAmounts,
  isZeroAmount,
  subtractAmounts,
} from '@/ledger/amount';
import { Money } from '@/components/money/Money';
import { symbolOf } from '@/components/money/asset';
import { CryptoAmount } from '@/components/money/CryptoAmount';
import { GainLoss } from '@/components/money/GainLoss';
import { formatFiat } from '@/components/money/format';
import type {
  CarryForward,
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
  carryForward?: CarryForward;
};

/** Decimal point only: `1.000,50` must be rejected, not silently misread. */
const CARRY_AMOUNT = /^\d+(\.\d+)?$/;

/** A year the carry-forward can be stored under and labelled with. */
const CARRY_YEAR = /^\d+$/;

/** Printed under a figure a carry-forward has reduced: the return takes the
 *  figure before it. Shared by the Result and derivatives cards. */
const CARRY_APPLIED_BY_FINANZAMT =
  'The Finanzamt applies the carry-forward it has recorded; declare the gain before it.';

/** Printed under "Loss to declare" when a carry-forward was entered: the
 *  loss to declare is the year's own, and the Finanzamt adds the carry. */
const CARRY_ADDED_BY_FINANZAMT =
  'The Finanzamt adds the remaining carry-forward to this itself.';

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
        <p data-print="subheading" className="text-sm font-medium">
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
                {/* A cost the host could not price: the event itself was
                    computed, only the deduction is missing, and without
                    this the row reads as a second failed disposal of the
                    same coins. */}
                {item.subject === 'cost' && <>{t('Fee, not deducted')} · </>}
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
  // Optional: the screen is also rendered without a provider in isolation.
  const clientCtx = useContext(ClientContext);
  const readOnly = clientCtx?.readOnly ?? false;
  // Named on the printout only when there is someone to tell apart: a sole
  // client (the migrated single user) prints no client line and no footer
  // label, while a review always names itself.
  const clientLabel =
    clientCtx &&
    (clientCtx.client.kind === 'review' ||
      listClients().filter((c) => c.kind === 'client').length > 1)
      ? labelOf(clientCtx.client, t)
      : '';
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

  /**
   * Which of the two screens inside a chosen jurisdiction is showing.
   *
   * Explicit state rather than derived from `assessment`, because the two
   * transitions it has to support pull in opposite directions: stepping
   * back from a finished report must KEEP that report (a run is one
   * historical price lookup per disposal and takes minutes, so re-reading
   * an input cannot cost one), while changing an input that feeds it must
   * drop it. Derived from `assessment !== null`, the first of those would
   * be impossible.
   */
  const [step, setStep] = useState<'form' | 'report'>('form');
  const [datev, setDatev] = useState<DatevSettings | undefined>(undefined);
  const [datevOpen, setDatevOpen] = useState(false);
  const [module, setModule] = useState<TaxModule | null>(null);
  // Built once, when the jurisdiction is actually chosen (an event
  // handler, not render), because `buildDisclaimer` takes the current time
  // - calling Date.now() directly during render is an impure read that
  // react-hooks/purity correctly rejects.
  const [disclaimer, setDisclaimer] = useState<Disclaimer | null>(null);
  const [initialYear] = useState(String(new Date().getUTCFullYear()));
  const [year, setYear] = useState(initialYear);
  // The year as of the last render, for the settings read below: it may
  // land after the user has already changed the year, and must then seed
  // the carry inputs for the year showing, not the one mounted with.
  const yearRef = useRef(initialYear);
  useEffect(() => {
    yearRef.current = year.trim();
  }, [year]);
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
  // Losses carried INTO the chosen year, as the Finanzamt stated them. The
  // whole stored record is kept so a blur writes back the other years
  // untouched, and the inputs are re-seeded from it whenever the year
  // changes - a 2024 run must never read 2025's figure.
  const [lossRecord, setLossRecord] = useState<Record<string, CarryForward>>(
    {},
  );
  const [carryPrivate, setCarryPrivate] = useState('');
  const [carryCapital, setCarryCapital] = useState('');
  const [carryError, setCarryError] = useState(false);
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
      const record = settings?.lossCarryForward ?? {};
      setLossRecord(record);
      const stored = record[yearRef.current];
      setCarryPrivate(stored?.privateSales ?? '');
      setCarryCapital(stored?.capital ?? '');
    });
    return () => {
      active = false;
    };
  }, []);

  /**
   * Discards a finished report, because an input that feeds it changed.
   *
   * A report is only ever valid for the inputs that produced it, and the
   * screen used to keep showing one while the form above it said something
   * else - a 2025 report under a form reading 2026. Only the three inputs
   * the RUN consumes do this: the taxpayer's name and tax number are
   * printed on the sheet and enter no figure, so correcting a typo in one
   * must not cost a recomputation.
   */
  const invalidateReport = () => {
    setAssessment(null);
    setStatus('idle');
    setStep('form');
  };

  /** Written on blur, merging rather than replacing: the two fields have
   *  separate inputs and a write of one must not erase the other. */
  const persistTaxpayer = () => {
    if (readOnly || !taxpayerLoaded) {
      return;
    }
    void putSettings({
      taxpayer: { name: taxpayerName, taxNumber },
    });
  };

  /** The year the carry inputs are keyed by and the Bescheid's "as at"
   *  year before it, or null while the year field does not hold one. */
  const carryYear = CARRY_YEAR.test(year.trim())
    ? { prevYear: Number(year.trim()) - 1 }
    : null;

  /** Seeds the two inputs from the stored figure for `nextYear`. */
  const loadCarryFor = (nextYear: string) => {
    const stored = lossRecord[nextYear];
    setCarryPrivate(stored?.privateSales ?? '');
    setCarryCapital(stored?.capital ?? '');
    setCarryError(false);
  };

  /** Written on blur, keyed by the year carried into. Validated with the
   *  same rule as the run: an invalid figure is never stored, so it cannot
   *  come back as the seeded value next time; the field keeps showing it,
   *  with the error, until it is corrected. */
  const persistCarry = () => {
    if (readOnly || !taxpayerLoaded || !CARRY_YEAR.test(year.trim())) {
      return;
    }
    const key = year.trim();
    const privateSales = carryPrivate.trim() || undefined;
    const capital = carryCapital.trim() || undefined;
    if (
      (privateSales !== undefined && !CARRY_AMOUNT.test(privateSales)) ||
      (capital !== undefined && !CARRY_AMOUNT.test(capital))
    ) {
      setCarryError(true);
      return;
    }
    setCarryError(false);
    if (
      lossRecord[key] === undefined &&
      privateSales === undefined &&
      capital === undefined
    ) {
      return;
    }
    const next = { ...lossRecord, [key]: { privateSales, capital } };
    setLossRecord(next);
    void putSettings({ lossCarryForward: next });
  };

  const chooseModule = (next: TaxModule) => {
    setModule(next);
    setDisclaimer(buildDisclaimerNow(next.manifest));
    setStatus('idle');
    setError(null);
    setAssessment(null);
    setStep('form');
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
    let carryForward: CarryForward | undefined;
    if (module.manifest.supportsCarryForward) {
      const privateSales = carryPrivate.trim();
      const capital = carryCapital.trim();
      if (
        (privateSales !== '' && !CARRY_AMOUNT.test(privateSales)) ||
        (capital !== '' && !CARRY_AMOUNT.test(capital))
      ) {
        setCarryError(true);
        return;
      }
      if (privateSales !== '' || capital !== '') {
        carryForward = {
          ...(privateSales === '' ? {} : { privateSales }),
          ...(capital === '' ? {} : { capital }),
        };
      }
    }
    setCarryError(false);
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
      carryForward,
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
    // Captured when the run starts: a key write that resolves after a
    // client switch is refused rather than stored in the other client.
    const ledger = activeLedgerName();

    (async () => {
      try {
        if (request.apiKey !== undefined) {
          // Awaited before the run, not fire-and-forget: resolveValues
          // reads the key from settings, so a write still in flight would
          // be a race the first run of a new key loses. An empty input
          // clears the stored key rather than storing ''.
          // A review client's ledger is someone else's restored data: the
          // key stays in component state for this run and is not stored.
          if (!readOnly) {
            await putSettings(
              {
                coingeckoApiKey:
                  request.apiKey === '' ? undefined : request.apiKey,
              },
              { ledger },
            );
          }
          if (cancelled) {
            return;
          }
          setLoadedApiKey(request.apiKey);
        }
        const result = await runTaxReport(request.module, {
          year: request.year,
          baseCurrency: request.baseCurrency,
          rate: request.rate,
          carryForward: request.carryForward,
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
        setSourceDirectory(
          buildSourceDirectory(
            sources,
            events,
            (moduleId) => findModule(moduleId)?.manifest.fields,
          ),
        );
        setAssessment(result);
        setStatus('done');
        setStep('report');
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
  }, [request, readOnly]);

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

  // The live DATEV values come from the settings card through `onChange`;
  // the stored ones fill in only while the card has reported nothing, so a
  // read racing a pending write (or a review's session values, which are
  // never written) cannot overwrite what is on screen.
  useEffect(() => {
    if (step !== 'report') {
      return;
    }
    let active = true;
    getSettings()
      .then((stored) => {
        if (active) {
          setDatev((live) => live ?? stored?.datev);
        }
      })
      .catch((error: unknown) => {
        console.error('Could not read the DATEV settings', error);
      });
    return () => {
      active = false;
    };
  }, [step]);

  /** Hands a file to the browser, the way the checkpoint dialog does. Bytes
   *  go into the Blob as they are, never through a UTF-8 encoder. */
  const download = (
    content: string | Uint8Array,
    filename: string,
    type: string,
  ) => {
    const blob = new Blob([content as BlobPart], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadRegister = () => {
    if (!assessment) {
      return;
    }
    download(
      registerToCsv(assessment.register),
      registerFilename(assessment.year, assessment.method.fingerprint, 'csv'),
      'text/csv;charset=utf-8',
    );
  };

  const DATEV_FIELD_LABELS: Record<DatevSettingsIssue['field'], string> = {
    beraternummer: 'Advisor number',
    mandantennummer: 'Client number',
    sachkontenlaenge: 'Account number length',
    'konten.verrechnung': 'Clearing account',
    'konten.gewinn23': 'Account for §23 gains',
    'konten.verlust23': 'Account for §23 losses',
    'konten.einkuenfte22': 'Account for §22 Nr. 3 income',
  };
  const datevIssues = validateDatevSettings(datev);
  const datevNotEuro = assessment?.method.baseCurrency !== 'eur';
  const datevPostings =
    assessment && datev && datevIssues.length === 0 && !datevNotEuro
      ? postingsFromReport(assessment, datev)
      : [];

  const handleDownloadDatev = () => {
    if (!assessment || !datev) {
      return;
    }
    const text = buchungsstapel(
      postingsFromReport(assessment, datev),
      {
        year: assessment.year,
        fingerprint: assessment.method.fingerprint,
        createdAt: new Date(),
        appVersion: assessment.method.appVersion,
      },
      datev,
    );
    download(
      encodeCp1252(text),
      datevFilename(assessment.year, assessment.method.fingerprint),
      'text/csv;charset=windows-1252',
    );
    setDatevOpen(false);
  };

  const handleDownloadJson = () => {
    if (!assessment) {
      return;
    }
    download(
      reportToJson(assessment, {
        generatedAt: new Date().toISOString(),
        sourceDirectory,
      }),
      registerFilename(assessment.year, assessment.method.fingerprint, 'json'),
      'application/json',
    );
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

  /**
   * What the PRINTED list carries in full, and what it only counts.
   *
   * In full: everything inside the tax year, and every disposal whatever
   * its year - those are the items that moved, or failed to move, a figure
   * on this sheet. Counted: the rest, which is acquisitions from earlier
   * years that could not be priced. The distinction is the host's own:
   * `taxEventKind` is what `omitted` is already computed from.
   */
  const printedInFull = (assessment?.unresolved ?? []).filter(
    (item) =>
      new Date(item.timestamp).getUTCFullYear() === assessment?.year ||
      item.taxEventKind === 'disposal',
  );
  const summarised = (assessment?.unresolved ?? []).filter(
    (item) => !printedInFull.includes(item),
  );
  const summarisedCount = summarised.length;
  const summarisedFrom = Math.min(...summarised.map((i) => i.timestamp));
  const summarisedTo = Math.max(...summarised.map((i) => i.timestamp));

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
    <div
      // The print stylesheet's hook for the document's text block. A data
      // attribute rather than a class, because what print needs from this
      // element - a measure and a page inset - has nothing to do with the
      // screen utilities on it, and keying the two together means a Tailwind
      // change silently restyles the paper.
      data-print="document"
      className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-6 p-6"
    >
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
              {/* The letterhead. Print only, and above everything: a sheet
                  that arrives at a tax office with no issuer reads as an
                  anonymous printout, and the reader has no way to tell what
                  produced the figures or where to check it. The mark is an
                  SVG in the document flow, so it prints whether or not the
                  dialog's "background graphics" box is ticked - unlike the
                  gradient rule below it, which is decoration and is allowed
                  to be absent. */}
              {step === 'report' && assessment && (
                <div
                  data-print="letterhead"
                  className="hidden flex-col gap-2 print:flex"
                >
                  <div className="flex items-end justify-between gap-4">
                    <span className="flex items-center gap-2">
                      <img
                        src={markBlack}
                        alt=""
                        aria-hidden="true"
                        data-print="mark"
                      />
                      <span className="text-lg font-semibold">Coineda</span>
                    </span>
                    <span className="text-sm">{t('Tax report')}</span>
                  </div>
                  <div data-print="rule" aria-hidden="true" />
                </div>
              )}
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
              {step === 'report' && assessment && (
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
                  {clientLabel && clientLabel !== taxpayerName && (
                    <p>
                      <span className="font-medium">{t('Client')}: </span>
                      {clientLabel}
                    </p>
                  )}
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
                    {t(
                      'Rule set {{jurisdiction}} {{version}}, checked on {{date}}',
                      {
                        jurisdiction: t(module.manifest.jurisdiction),
                        version: disclaimer.rulesVersion,
                        date: new Intl.DateTimeFormat(i18n.language, {
                          dateStyle: 'medium',
                        }).format(Date.parse(disclaimer.rulesCheckedOn)),
                      },
                    )}
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
                  <p data-print="notice" className="text-muted-foreground">
                    {t(disclaimer.noticeKey)}
                  </p>
                </CardContent>
              </Card>
            )}

            {/* The form is a STEP, not a header above the result.
                Appending a finished document underneath the controls that
                produced it read as "content suddenly appeared", and a
                result left standing while the form above it said something
                else was worse than confusing - it was wrong. */}
            {step === 'form' && (
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
                      onChange={(event) => {
                        setYear(event.target.value);
                        loadCarryFor(event.target.value.trim());
                        invalidateReport();
                      }}
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
                      onChange={(event) => {
                        setRate(event.target.value);
                        invalidateReport();
                      }}
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
                      onChange={(event) => {
                        setApiKey(event.target.value);
                        invalidateReport();
                      }}
                      disabled={status === 'loading'}
                    />
                    <p className="text-sm text-muted-foreground">
                      {t(
                        "Optional. Needed only to price tax events more than 365 days old - CoinGecko's free tier only covers the last year of history.",
                      )}
                    </p>
                  </div>
                  {/* Only for a year that parses: the labels name the
                      Bescheid's "as at 31 Dec" date, the year before, and
                      a year that cannot be stored under cannot be named. */}
                  {module?.manifest.supportsCarryForward && carryYear && (
                    <>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="tax-report-carry-private">
                          {t(
                            'Remaining loss carry-forward under §23 EStG as at 31 Dec {{prevYear}} (Verlustfeststellungsbescheid)',
                            { prevYear: carryYear.prevYear },
                          )}
                        </Label>
                        <Input
                          id="tax-report-carry-private"
                          inputMode="decimal"
                          value={carryPrivate}
                          aria-invalid={carryError || undefined}
                          onChange={(event) => {
                            setCarryPrivate(event.target.value);
                            invalidateReport();
                          }}
                          onBlur={persistCarry}
                          disabled={status === 'loading' || readOnly}
                        />
                      </div>
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="tax-report-carry-capital">
                          {t(
                            'Remaining loss carry-forward under §20 EStG as at 31 Dec {{prevYear}}, excluding losses from selling shares (§20 Abs. 6 S. 4)',
                            { prevYear: carryYear.prevYear },
                          )}
                        </Label>
                        <Input
                          id="tax-report-carry-capital"
                          inputMode="decimal"
                          value={carryCapital}
                          aria-invalid={carryError || undefined}
                          onChange={(event) => {
                            setCarryCapital(event.target.value);
                            invalidateReport();
                          }}
                          onBlur={persistCarry}
                          disabled={status === 'loading' || readOnly}
                        />
                        <p className="text-sm text-muted-foreground">
                          {t(
                            'From your Verlustfeststellungsbescheid. Only the Finanzamt knows this figure; stored only on this device.',
                          )}
                        </p>
                      </div>
                      {carryError && (
                        <p className="text-sm text-destructive" role="alert">
                          {t('Enter an amount like 1234.56')}
                        </p>
                      )}
                    </>
                  )}
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="tax-report-taxpayer-name">
                      {t('Your name')}
                    </Label>
                    <Input
                      id="tax-report-taxpayer-name"
                      value={taxpayerName}
                      onChange={(event) => setTaxpayerName(event.target.value)}
                      onBlur={persistTaxpayer}
                      disabled={status === 'loading' || readOnly}
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
                      disabled={status === 'loading' || readOnly}
                    />
                  </div>
                  {module?.manifest.id === 'de' && (
                    <DatevSettingsCard value={datev} onChange={setDatev} />
                  )}
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
            )}

            {step === 'report' && assessment && (
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
                      <p className="text-muted-foreground">
                        {t(
                          "Trades against a fiat currency are valued at the fiat amount actually paid or received, converted at the ECB reference rate when it is not the base currency; everything else at the day's market price.",
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
                        {' · '}
                        {t('Rule set {{jurisdiction}} {{version}}', {
                          jurisdiction: t(module.manifest.jurisdiction),
                          version: assessment.method.rulesVersion,
                        })}
                      </p>
                      <p>
                        <span className="font-medium">
                          {t('Ledger fingerprint')}:{' '}
                        </span>
                        <span className="font-mono break-all">
                          {assessment.method.fingerprint}
                        </span>
                      </p>
                      <p className="text-muted-foreground">
                        {t(
                          'SHA-256 over every recorded event and confirmed transfer link this report read. A backup file exported from the same ledger carries the same fingerprint.',
                        )}
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
                      {assessment.method.transferResiduals > 0 && (
                        <p className="text-muted-foreground">
                          {t(
                            '{{count}} network fee on a transfer between your own wallets was treated as a disposal of the fee coins and not deducted.',
                            { count: assessment.method.transferResiduals },
                          )}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </div>

                {/* 1b. Which wallets and exchanges the figures came from.
                    A reader at a tax office has to be able to ask for the
                    statements behind a number, and cannot do that without
                    knowing which accounts produced it. Built from the
                    sources joined to their events; of SourceRecord.config
                    only public address/xpub fields are read, never
                    credentials. */}
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
                          {entry.identities.length > 0 && (
                            <p>
                              <span className="font-medium">
                                {t('Addresses and keys')}:{' '}
                              </span>
                              {entry.identities.map((identity, index) => (
                                <span key={identity}>
                                  {index > 0 && ' · '}
                                  <span className="break-all font-mono">
                                    {identity}
                                  </span>
                                </span>
                              ))}
                            </p>
                          )}
                          {entry.hasXpub && (
                            <p className="text-xs text-muted-foreground">
                              {t(
                                'An extended public key reveals every address of the wallet; hand this report only to those who should know them.',
                              )}
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
                    same paragraph - see the class doc comment above.

                    Under its own heading since the print stylesheet turned
                    every Card into a bare block: without one the single
                    most important section of the document - the figures
                    that go on the return - arrived on paper with no label,
                    sandwiched between the source directory and the
                    thresholds. */}
                <h3 className="text-sm font-semibold">{t('Result')}</h3>
                <Card>
                  <CardContent className="flex flex-col gap-2">
                    {/* With a carry-forward the return still takes the
                        year's own gain - the Finanzamt deducts the carry it
                        has recorded itself - so that figure comes first and
                        the reduced one is labelled as the estimate it is.
                        `thresholds[0]` is the §23 Freigrenze test, whose
                        `actual` is the year's gain before any carry. */}
                    {assessment.carryForward?.privateSales &&
                      assessment.thresholds[0] && (
                        <p data-testid="gain-before-carry">
                          <span className="font-medium">
                            {t('Gain to declare (before loss carry-forward)')}
                            :{' '}
                          </span>
                          <Money
                            value={Number(assessment.thresholds[0].actual)}
                            currency={baseCurrency}
                          />
                        </p>
                      )}
                    <p>
                      <span className="font-medium">
                        {t(
                          assessment.carryForward?.privateSales
                            ? 'Taxable gain after carry-forward (estimate)'
                            : 'Taxable gain',
                        )}
                        :{' '}
                      </span>
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
                    {assessment.carryForward?.privateSales && (
                      <p className="text-sm text-muted-foreground">
                        {t(CARRY_APPLIED_BY_FINANZAMT)}
                      </p>
                    )}
                    {assessment.carryForward?.privateSales && (
                      <p data-testid="carry-forward-private">
                        {t(
                          'Loss carry-forward as stated by the Finanzamt: {{declared}} · {{used}} used this year · {{remaining}} remaining',
                          {
                            declared: formatFiat(
                              Number(
                                assessment.carryForward.privateSales.declared,
                              ),
                              i18n.language,
                              baseCurrency,
                            ),
                            used: formatFiat(
                              Number(assessment.carryForward.privateSales.used),
                              i18n.language,
                              baseCurrency,
                            ),
                            remaining: formatFiat(
                              Number(
                                assessment.carryForward.privateSales.remaining,
                              ),
                              i18n.language,
                              baseCurrency,
                            ),
                          },
                        )}
                      </p>
                    )}
                    {/* The remaining unresolved items, counted and named
                        separately rather than folded into the disposal
                        count above: an unpriced acquisition or native-token
                        leg is a real gap, but calling it a disposal that
                        could not be computed is what trained users to
                        ignore this warning - the recorded one-wallet report
                        showed 56 of them. */}
                    {/* The ones behind that count, named.
                        A warning that says "2 disposals could not be
                        computed" and stops there leaves the reader to find
                        those two among every other gap in the ledger - 65
                        of them in the report that prompted this - and a
                        warning nobody can act on is one they learn to
                        ignore. Each row carries what it takes to find the
                        transaction again: the date, the wallet, the asset
                        and, where the ledger knows one, the hash. */}
                    {assessment.omittedDisposals.length > 0 && (
                      <ul
                        data-testid="omitted-disposals"
                        className="flex flex-col gap-1 text-sm"
                      >
                        {assessment.omittedDisposals.map((item, index) => (
                          <li
                            key={`${item.sourceEventId}-${item.assetId}-${index}`}
                            className="text-destructive"
                          >
                            {formatDate(item.timestamp)} · {item.venue} ·{' '}
                            <CryptoAmount
                              value={item.amount}
                              assetId={item.assetId}
                            />
                            {item.txHash !== undefined && (
                              <>
                                {' · '}
                                <span className="break-all">{item.txHash}</span>
                              </>
                            )}
                            {' — '}
                            {t(item.reason.key, item.reason.params)}
                          </li>
                        ))}
                      </ul>
                    )}
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
                    {!isZeroAmount(assessment.totals.loss) &&
                      assessment.carryForward?.privateSales && (
                        <p className="text-sm text-muted-foreground">
                          {t(CARRY_ADDED_BY_FINANZAMT)}
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

                {/* 2b. Derivatives (§20 EStG). Only a jurisdiction that
                    classifies capital events returns `capitalResult`; for
                    every other report the section does not exist. */}
                {assessment.capitalResult !== undefined && (
                  <div className="flex flex-col gap-2" data-testid="capital">
                    <h3 className="text-sm font-semibold">
                      {t('Derivatives (§20 EStG)')}
                    </h3>
                    <Card>
                      <CardContent className="flex flex-col gap-1 text-sm">
                        {(
                          [
                            ['Gains', assessment.capitalResult.gains],
                            ['Losses', assessment.capitalResult.losses],
                            ['Net result', assessment.capitalResult.net],
                          ] as const
                        ).map(([label, figure]) => (
                          <p key={label}>
                            <span className="font-medium">{t(label)}: </span>
                            <Money
                              value={Number(figure)}
                              currency={baseCurrency}
                            />
                          </p>
                        ))}
                        {/* The carry sits where it is subtracted - after the
                            net, before the allowance - so the card reads as
                            the arithmetic it is, top to bottom. */}
                        {assessment.carryForward?.capital && (
                          <p data-testid="carry-forward-capital">
                            {t(
                              'Loss carry-forward as stated by the Finanzamt: {{declared}} · {{used}} used this year · {{remaining}} remaining',
                              {
                                declared: formatFiat(
                                  Number(
                                    assessment.carryForward.capital.declared,
                                  ),
                                  i18n.language,
                                  baseCurrency,
                                ),
                                used: formatFiat(
                                  Number(assessment.carryForward.capital.used),
                                  i18n.language,
                                  baseCurrency,
                                ),
                                remaining: formatFiat(
                                  Number(
                                    assessment.carryForward.capital.remaining,
                                  ),
                                  i18n.language,
                                  baseCurrency,
                                ),
                              },
                            )}
                          </p>
                        )}
                        {(
                          [
                            [
                              'Allowance applied',
                              assessment.capitalResult.allowance,
                            ],
                            ['Taxable', assessment.capitalResult.taxable],
                          ] as const
                        ).map(([label, figure]) => (
                          <p key={label}>
                            <span className="font-medium">{t(label)}: </span>
                            <Money
                              value={Number(figure)}
                              currency={baseCurrency}
                            />
                          </p>
                        ))}
                        {assessment.capitalResult.carryForwardUsed !== '0' && (
                          <p className="text-muted-foreground">
                            {t(CARRY_APPLIED_BY_FINANZAMT)}
                          </p>
                        )}
                        {!isZeroAmount(
                          assessment.capitalResult.notDeducted,
                        ) && (
                          <p>
                            <span className="font-medium">
                              {t('Not deducted')}:{' '}
                            </span>
                            <Money
                              value={Number(
                                assessment.capitalResult.notDeducted,
                              )}
                              currency={baseCurrency}
                            />
                          </p>
                        )}
                        {!isZeroAmount(assessment.capitalResult.loss) && (
                          <p>
                            <span className="font-medium">
                              {t('Loss to declare')}:{' '}
                            </span>
                            <Money
                              value={Number(assessment.capitalResult.loss)}
                              currency={baseCurrency}
                            />
                          </p>
                        )}
                        {!isZeroAmount(assessment.capitalResult.loss) &&
                          assessment.carryForward?.capital && (
                            <p className="text-muted-foreground">
                              {t(CARRY_ADDED_BY_FINANZAMT)}
                            </p>
                          )}
                        {assessment.capitalResult.estimatedTax !==
                          undefined && (
                          <p>
                            <span className="font-medium">
                              {t('Estimated tax liability')}:{' '}
                            </span>
                            <Money
                              value={Number(
                                assessment.capitalResult.estimatedTax,
                              )}
                              currency={baseCurrency}
                            />
                          </p>
                        )}
                        <p className="text-muted-foreground">
                          {t(assessment.capitalResult.note)}
                        </p>
                      </CardContent>
                    </Card>
                    <div
                      className="flex flex-col gap-2"
                      data-testid="capital-lines"
                    >
                      {assessment.capital.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          {t('No derivative settlements in this year.')}
                        </p>
                      ) : (
                        // One settlement can yield a gain and a loss (its
                        // principal and its fee) under one sourceEventId.
                        assessment.capital.map((row, index) => (
                          <Card
                            key={`${row.sourceEventId}-${row.kind}-${index}`}
                          >
                            <CardContent className="flex flex-col gap-1 text-sm">
                              <p className="font-medium">
                                {formatDate(row.timestamp)} · {row.venue} ·{' '}
                                <CryptoAmount
                                  value={row.amount}
                                  assetId={row.assetId}
                                />{' '}
                                · {t(row.kind === 'gain' ? 'Profit' : 'Loss')}
                                {row.derivativeKind !== undefined && (
                                  <>
                                    {' '}
                                    ·{' '}
                                    {t(
                                      DERIVATIVE_KIND_LABELS[
                                        row.derivativeKind
                                      ],
                                    )}
                                  </>
                                )}
                                {row.instrument !== undefined && (
                                  <> · {row.instrument}</>
                                )}
                              </p>
                              <p>
                                <Money
                                  value={Number(row.value)}
                                  currency={baseCurrency}
                                />
                                {!row.deducted && (
                                  <span className="ml-2 text-muted-foreground">
                                    ({t('not deducted')})
                                  </span>
                                )}
                                {row.priceSource !== undefined && (
                                  <span className="text-xs text-muted-foreground">
                                    {' '}
                                    · {t('priced by')}{' '}
                                    {describePriceSource(row.priceSource, t)}
                                  </span>
                                )}
                              </p>
                              {row.note !== undefined && (
                                <p className="text-muted-foreground">
                                  {t(row.note)}
                                </p>
                              )}
                            </CardContent>
                          </Card>
                        ))
                      )}
                    </div>
                  </div>
                )}
                {/* 2c. Filing aid. Printed: it is the page a user holds
                    beside the form. Absent for a module that supplies no
                    `filing`. Line numbers print only when the year's form
                    was verified (each entry then carries a reference). The
                    German forms take euros, so a report in any other
                    currency prints the heading and one sentence only. */}
                {assessment.filing !== undefined && (
                  <div className="flex flex-col gap-2" data-testid="filing-aid">
                    <h3 className="text-sm font-semibold">
                      {t('Filing aid — Anlage SO and Anlage KAP {{year}}', {
                        year: assessment.filing.year,
                      })}
                    </h3>
                    {assessment.method.baseCurrency !== 'eur' ? (
                      <p className="text-sm text-muted-foreground">
                        {t(
                          'The German forms take euros; this report is in {{currency}}, so no filing figures are shown.',
                          {
                            currency:
                              assessment.method.baseCurrency.toUpperCase(),
                          },
                        )}
                      </p>
                    ) : (
                      <>
                        {assessment.filing.verifiedBy !== undefined && (
                          <p className="text-sm text-muted-foreground">
                            {t(
                              'Line numbers verified against {{source}} on {{date}}.',
                              {
                                source: assessment.filing.verifiedBy.source,
                                // A calendar date: local midnight, so the
                                // formatter cannot shift it across a time zone.
                                date: formatDate(
                                  Date.parse(
                                    `${assessment.filing.verifiedBy.checkedOn}T00:00:00`,
                                  ),
                                ),
                              },
                            )}
                          </p>
                        )}
                        {/* This year's gaps only, counted once: omitted
                            disposals are already in `unresolved`. */}
                        {unresolvedInYear > 0 && (
                          <p className="text-sm text-destructive">
                            {t(
                              'These figures are incomplete: {{count}} items were omitted or left unresolved (see the Result card). Resolve them before you type anything in.',
                              {
                                count: unresolvedInYear,
                              },
                            )}
                          </p>
                        )}
                        {!assessment.filing.linesVerified && (
                          <p className="text-sm text-muted-foreground">
                            {t(
                              'The line numbers of the {{year}} form are not verified; use the section names.',
                              { year: assessment.filing.year },
                            )}
                          </p>
                        )}
                        {assessment.filing.sections.map((section) => (
                          <Card key={section.title}>
                            <CardContent className="flex flex-col gap-1 text-sm">
                              <p className="font-medium">{t(section.title)}</p>
                              {section.entries.map((entry, index) => (
                                <div key={`${entry.label}-${index}`}>
                                  <p>
                                    {entry.reference !== undefined && (
                                      <span className="text-muted-foreground">
                                        {t('Line {{line}}', {
                                          line: entry.reference.line,
                                        })}
                                        {' · '}
                                      </span>
                                    )}
                                    <span className="font-medium">
                                      {t(entry.label)}
                                      {entry.amount !== undefined ||
                                      entry.text !== undefined
                                        ? ': '
                                        : ''}
                                    </span>
                                    {entry.amount !== undefined && (
                                      <Money
                                        value={Number(entry.amount)}
                                        currency={baseCurrency}
                                      />
                                    )}
                                    {entry.text !== undefined && (
                                      <span>{entry.text}</span>
                                    )}
                                  </p>
                                  {entry.note !== undefined && (
                                    <p className="text-muted-foreground">
                                      {t(entry.note)}
                                    </p>
                                  )}
                                </div>
                              ))}
                            </CardContent>
                          </Card>
                        ))}
                        <p className="text-sm text-muted-foreground">
                          {t(
                            "The Finanzamt applies the Freigrenzen, the saver's allowance and any loss carry-forward itself; they are not typed in.",
                          )}
                        </p>
                      </>
                    )}
                  </div>
                )}

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
                            {/* On screen CryptoAmount renders the asset's
                                MARK, so the ticker beside it is the only
                                thing naming the asset in letters. In print
                                the mark is replaced by that same ticker,
                                and the line read "ADA · 1.250 ADA". */}
                            <span className="print:hidden">
                              {symbolOf(line.assetId)} ·{' '}
                            </span>
                            <CryptoAmount
                              value={line.amount}
                              assetId={line.assetId}
                            />{' '}
                            · {line.venue}
                          </p>
                          <p>
                            {/* Only when something came off: a line that
                                says "Fees: 0,00 EUR" under every disposal
                                buries the ones where a fee mattered. When
                                it did, gross, fee and net are printed in
                                that order, because `proceeds` is already
                                net and "Proceeds: X, of which fees: Y"
                                read as though Y were inside X. */}
                            {isZeroAmount(line.costs) ? (
                              <>
                                {t('Proceeds')}:{' '}
                                <Money
                                  value={Number(line.proceeds)}
                                  currency={baseCurrency}
                                />{' '}
                              </>
                            ) : (
                              <>
                                {t('Sale value')}:{' '}
                                <Money
                                  value={Number(
                                    addAmounts(line.proceeds, line.costs),
                                  )}
                                  currency={baseCurrency}
                                />{' '}
                                · {t('Fees deducted')}:{' '}
                                <Money
                                  value={Number(line.costs)}
                                  currency={baseCurrency}
                                />{' '}
                                · {t('Proceeds after fees')}:{' '}
                                <Money
                                  value={Number(line.proceeds)}
                                  currency={baseCurrency}
                                />{' '}
                              </>
                            )}
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
                            {line.priceSource !== undefined && (
                              <span className="text-xs text-muted-foreground">
                                {' '}
                                · {t('priced by')}{' '}
                                {describePriceSource(line.priceSource, t)}
                              </span>
                            )}
                          </p>
                          <p className="text-muted-foreground">
                            {t(line.reason.key, line.reason.params)}
                          </p>
                          {line.origin !== undefined && (
                            <p className="text-muted-foreground">
                              {t(line.origin.key)}
                              {line.origin.txHash !== undefined && (
                                <>
                                  {' · '}
                                  <span className="font-mono break-all">
                                    {line.origin.txHash}
                                  </span>
                                </>
                              )}
                            </p>
                          )}
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

                {/* 5. Income, one row per event. The total above is what
                    the Freigrenze is tested against; these are what it is
                    made of. Printed in full, like the disposals: a sum a
                    reader cannot decompose is a sum they cannot check. */}
                <div className="flex flex-col gap-2" data-testid="income-lines">
                  <h3 className="text-sm font-semibold">{t('Income')}</h3>
                  {assessment.income.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t('No income in this year.')}
                    </p>
                  ) : (
                    assessment.income.map((row) => (
                      <Card key={row.sourceEventId}>
                        <CardContent className="flex flex-col gap-1 text-sm">
                          <p className="font-medium">
                            {row.rewardKind !== undefined && (
                              <>{t(REWARD_KIND_LABELS[row.rewardKind])} · </>
                            )}
                            {formatDate(row.timestamp)} ·{' '}
                            <span className="print:hidden">
                              {symbolOf(row.assetId)} ·{' '}
                            </span>
                            <CryptoAmount
                              value={row.amount}
                              assetId={row.assetId}
                            />{' '}
                            · {row.venue}
                          </p>
                          <p>
                            {t('Value at receipt')}:{' '}
                            <Money
                              value={Number(row.value)}
                              currency={baseCurrency}
                            />
                            {row.priceSource !== undefined && (
                              <span className="text-xs text-muted-foreground">
                                {' '}
                                · {t('priced by')}{' '}
                                {describePriceSource(row.priceSource, t)}
                              </span>
                            )}
                          </p>
                          {row.note !== undefined && (
                            <p className="text-muted-foreground">
                              {t(row.note)}
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    ))
                  )}
                </div>

                {/* 6. Unresolved items, grouped by kind, each reason shown
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
                        items={printedInFull}
                        t={t}
                        formatDate={formatDate}
                      />
                      {/* What is left is counted, dated and described
                          rather than listed.
                          These are acquisitions from earlier years that
                          carry no price - 60 of them in the report that
                          prompted this, mostly NFTs and dust tokens with no
                          market. None of them is a disposal and none falls
                          in the tax year, so none bears on a single figure
                          above; printed in full they ran to six pages and
                          buried the two items that did. Nothing is hidden:
                          the count is exact, the span is named, and the
                          screen still lists every one. */}
                      {summarisedCount > 0 && (
                        <p data-testid="unresolved-summary" className="text-sm">
                          {t(
                            '{{count}} further acquisitions from {{from}} to {{to}} could not be priced. None of them is a disposal and none falls in {{year}}, so none affects the figures above. They are listed in full in the app.',
                            {
                              count: summarisedCount,
                              from: formatDate(summarisedFrom),
                              to: formatDate(summarisedTo),
                              year: assessment.year,
                            },
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Repeats on every printed page (position: fixed), so a loose
                sheet still says whose figures it shows. The @page bottom
                margin in index.css keeps it clear of the content. */}
            {step === 'report' && assessment && (
              <div
                data-print="page-footer"
                className="hidden text-xs print:fixed print:right-0 print:bottom-0 print:left-0 print:block"
              >
                {clientLabel && <span>{clientLabel} · </span>}
                {t('Tax year')}: {assessment.year}
                <span>
                  {' '}
                  · {shortFingerprint(assessment.method.fingerprint)}
                </span>
              </div>
            )}

            {/* The colophon. Print only, and last.
                A reader at a tax office is being asked to accept figures
                from software they have never heard of, and Rn. 29b of the
                BMF letter this report cites makes the point that such a
                report carries no authority of its own. So the sheet says
                plainly what produced it, that the rules and the arithmetic
                are open to inspection, and where to find them - written out
                as a URL, because a hyperlink on paper is not one. */}
            {step === 'report' && assessment && (
              <div
                data-print="colophon"
                className="hidden flex-col gap-1 print:flex"
              >
                <div data-print="rule" aria-hidden="true" />
                <p>
                  <span className="font-medium">
                    {t('About {{app}}', { app: 'Coineda' })}:{' '}
                  </span>
                  {t(
                    'Coineda is open-source software for tracking crypto holdings and preparing a tax report. It runs entirely on this device: there is no server, no account, and no transmission of the data behind this report.',
                  )}
                </p>
                <p>
                  {t('Source code and licence (GPLv3)')}:{' '}
                  <span className="font-medium">
                    github.com/fabianbormann/Coineda
                  </span>
                </p>
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
              {step === 'form' ? (
                <>
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
                  {/* A finished report survives a step back to the form, so
                      there has to be a way forward to it that does not pay
                      for it twice. It disappears the moment an input that
                      feeds it changes, which is what makes the offer
                      honest: whatever this returns to was computed from
                      exactly what the form now says. */}
                  {assessment && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setStep('report')}
                    >
                      {t('View the report')}
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setStep('form')}
                  >
                    <ArrowLeft aria-hidden="true" />
                    {t('Change your answers')}
                  </Button>
                  <Button type="button" variant="outline" onClick={handlePrint}>
                    <Printer aria-hidden="true" />
                    {t('Print or save as PDF')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleDownloadRegister}
                  >
                    {t('Download register (CSV)')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleDownloadJson}
                  >
                    {t('Download report (JSON)')}
                  </Button>
                  {module?.manifest.id === 'de' && (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={datevIssues.length > 0 || datevNotEuro}
                        onClick={() => setDatevOpen(true)}
                      >
                        {t('Download DATEV (Buchungsstapel)')}
                      </Button>
                      {datevNotEuro ? (
                        <span className="text-xs text-muted-foreground">
                          {t('The DATEV export needs a report in euros.')}
                        </span>
                      ) : (
                        datevIssues.length > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {t(
                              'Complete the DATEV settings first: {{fields}}',
                              {
                                fields: [
                                  ...new Set(
                                    datevIssues.map((issue) =>
                                      t(DATEV_FIELD_LABELS[issue.field]),
                                    ),
                                  ),
                                ].join(', '),
                              },
                            )}
                          </span>
                        )
                      )}
                      <Dialog open={datevOpen} onOpenChange={setDatevOpen}>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>
                              {t('Download DATEV (Buchungsstapel)')}
                            </DialogTitle>
                            <DialogDescription>
                              {t('{{count}} postings', {
                                count: datevPostings.length,
                              })}
                            </DialogDescription>
                          </DialogHeader>
                          <p className="text-sm">
                            {t(
                              'The postings are the figures before the Freigrenzen and any loss carry-forward; the tax return applies those.',
                            )}
                          </p>
                          <p className="text-sm">
                            {t('Each posting is rounded to cents on its own.')}
                          </p>
                          {unresolvedInYear > 0 && (
                            <p className="text-sm text-destructive">
                              {t(
                                'These figures are incomplete: {{count}} items in this year were omitted or left unresolved (see the Result card). Postings for them are missing.',
                                { count: unresolvedInYear },
                              )}
                            </p>
                          )}
                          <DialogFooter>
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => setDatevOpen(false)}
                            >
                              {t('Cancel')}
                            </Button>
                            <Button type="button" onClick={handleDownloadDatev}>
                              {t('Download DATEV (Buchungsstapel)')}
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {t(
                      'In Excel, open the CSV via Data → From Text/CSV and choose the comma as separator.',
                    )}
                  </span>
                </>
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
