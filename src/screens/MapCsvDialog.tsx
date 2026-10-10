import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { FileDropArea } from '@/components/files/FileDropArea';
import { getEventsBySource, getSources } from '@/ledger/db';
import type { EventKind } from '@/ledger/types';
import { textFromFile } from '@/sources/csv/importFile';
import { readCsv, sniffDelimiter } from '@/sources/csv/readCsv';
import { parseMappedDate } from '@/sources/mapped-csv/dates';
import {
  missingColumns,
  previewMapped,
  validateMapping,
} from '@/sources/mapped-csv/parse';
import type { CsvMapping } from '@/sources/mapped-csv/types';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs the import. Rejects with a message the dialog shows in place. */
  onImport: (
    text: string,
    mapping: CsvMapping,
    fileName: string,
    options: { replaceExisting: boolean },
  ) => Promise<void>;
  /** A file already in hand; otherwise step 1 shows a drop area. */
  file?: File | null;
  /** The venue label to start with; a saved source of that label pre-fills. */
  label?: string;
};

type ColumnKey = keyof CsvMapping['columns'];

const COLUMN_FIELDS: { key: ColumnKey; label: string; required: boolean }[] = [
  { key: 'date', label: 'Date column', required: true },
  { key: 'asset', label: 'Asset column', required: true },
  { key: 'amount', label: 'Amount column', required: true },
  { key: 'type', label: 'Type column', required: false },
  { key: 'fee', label: 'Fee column', required: false },
  { key: 'feeAsset', label: 'Fee asset column', required: false },
  { key: 'counterAsset', label: 'Counter asset column', required: false },
  { key: 'counterAmount', label: 'Counter amount column', required: false },
  { key: 'price', label: 'Price column', required: false },
  { key: 'tradeId', label: 'Trade id column', required: false },
  { key: 'txHash', label: 'Transaction hash column', required: false },
];

const DATE_FORMATS: { value: CsvMapping['dateFormat']; label: string }[] = [
  { value: 'iso', label: 'ISO 8601' },
  { value: 'ymd', label: 'YYYY-MM-DD' },
  { value: 'dmy', label: 'DD.MM.YYYY' },
  { value: 'mdy', label: 'MM/DD/YYYY' },
  { value: 'unix-s', label: 'Unix seconds' },
  { value: 'unix-ms', label: 'Unix milliseconds' },
];

const ZONES = ['UTC', 'Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich'];
const OTHER_ZONE = '__other__';

const KIND_LABELS: Record<EventKind, string> = {
  trade: 'Trade',
  transfer: 'Transfer',
  reward: 'Reward',
  fee: 'Fee',
  'fiat-in': 'Deposit',
  'fiat-out': 'Withdrawal',
  derivative: 'Derivative settlement',
};

// No 'derivative': the module does not emit it, and a mapped row would carry
// none of the typed derivative fields a settlement needs.
const KINDS: EventKind[] = [
  'trade',
  'transfer',
  'reward',
  'fee',
  'fiat-in',
  'fiat-out',
];

const FIAT_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD'];

type Draft = {
  delimiter: CsvMapping['delimiter'];
  columns: Partial<Record<ColumnKey, string>>;
  dateFormat: CsvMapping['dateFormat'];
  zoneChoice: string; // one of ZONES or OTHER_ZONE
  zoneOther: string;
  decimal: CsvMapping['decimal'];
  mode: 'sign' | 'type';
  /** Two flags rather than one direction, so a conflicting SAVED mapping is
   *  shown as the conflict it is rather than silently resolved. Clicking
   *  keeps them exclusive (see `tag`). */
  tags: Record<string, { in?: boolean; out?: boolean }>;
  kinds: Record<string, EventKind>;
  fiatCounter: boolean;
  fiatCurrency: string;
};

const EMPTY: Draft = {
  delimiter: 'auto',
  columns: {},
  dateFormat: 'iso',
  zoneChoice: 'UTC',
  zoneOther: '',
  decimal: 'dot',
  mode: 'sign',
  tags: {},
  kinds: {},
  fiatCounter: false,
  fiatCurrency: 'EUR',
};

const draftFrom = (mapping: CsvMapping): Draft => {
  const tags: Draft['tags'] = {};
  if (mapping.direction.mode === 'type') {
    mapping.direction.in.forEach(
      (value) => (tags[value] = { ...tags[value], in: true }),
    );
    mapping.direction.out.forEach(
      (value) => (tags[value] = { ...tags[value], out: true }),
    );
  }
  const known = ZONES.includes(mapping.timeZone);
  return {
    delimiter: mapping.delimiter,
    columns: { ...mapping.columns },
    dateFormat: mapping.dateFormat,
    zoneChoice: known ? mapping.timeZone : OTHER_ZONE,
    zoneOther: known ? '' : mapping.timeZone,
    decimal: mapping.decimal,
    mode: mapping.direction.mode,
    tags,
    kinds: { ...mapping.kinds },
    fiatCounter: mapping.counter?.kind === 'fiat',
    fiatCurrency:
      mapping.counter?.kind === 'fiat' ? mapping.counter.currency : 'EUR',
  };
};

const SELECT_CLASS =
  'h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs';

export const MapCsvDialog = ({
  open,
  onOpenChange,
  onImport,
  file: initialFile = null,
  label: initialLabel = '',
}: Props) => {
  const { t } = useTranslation();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [file, setFile] = useState<File | null>(initialFile);
  const [text, setText] = useState('');
  const [label, setLabel] = useState(initialLabel);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  // Saved mappings by venue label, with how many events that venue holds.
  const [saved, setSaved] = useState<
    Record<string, { mapping: CsvMapping; count: number }>
  >({});
  // Off by default: replacing deletes the venue's earlier events, which only
  // the person can decide.
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [appliedFor, setAppliedFor] = useState<string | null>(null);
  // Set by the first edit to any control: a saved mapping that loads late
  // must not overwrite what the person has already changed.
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Start over each time the dialog is (re)opened. Adjusting state while
  // rendering, as AddSourceDialog does, so stale values never flash.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setStep(1);
      setFile(initialFile);
      setText('');
      setLabel(initialLabel);
      setDraft(EMPTY);
      setAppliedFor(null);
      setTouched(false);
      setReplaceExisting(false);
      setBusy(false);
      setError(null);
    }
  }

  // Saved mappings, by venue label.
  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const sources = await getSources();
      const found: Record<string, { mapping: CsvMapping; count: number }> = {};
      for (const source of sources) {
        if (source.moduleId !== 'mapped-csv' || !source.config.mapping) {
          continue;
        }
        let mapping: CsvMapping;
        try {
          mapping = JSON.parse(source.config.mapping);
        } catch {
          // A mapping that no longer parses is simply not offered.
          continue;
        }
        const events = await getEventsBySource(source.id);
        found[source.label] = {
          mapping,
          count: events.filter((event) => event.origin === 'derived').length,
        };
      }
      if (!cancelled) {
        setSaved(found);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // The file's text.
  useEffect(() => {
    if (!file) {
      return;
    }
    let cancelled = false;
    textFromFile(file).then(
      (read) => {
        if (!cancelled) {
          setText(read);
        }
      },
      (failure: unknown) => {
        if (!cancelled) {
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [file]);

  // Pre-fill from a saved source of this label, once per label.
  const savedVenue = saved[label.trim()];
  if (savedVenue && appliedFor !== label.trim()) {
    setAppliedFor(label.trim());
    if (!touched) {
      setDraft(draftFrom(savedVenue.mapping));
    }
  }

  const delimiter = useMemo(
    () =>
      draft.delimiter === 'auto'
        ? sniffDelimiter(
            text
              .slice(text.charCodeAt(0) === 0xfeff ? 1 : 0)
              .split(/\r\n|\n|\r/, 1)[0],
          )
        : draft.delimiter,
    [draft.delimiter, text],
  );
  const table = useMemo(
    () => (text ? readCsv(text, { delimiter }) : { header: [], rows: [] }),
    [text, delimiter],
  );

  const typeValues = useMemo(() => {
    const column = draft.columns.type;
    if (!column) {
      return [];
    }
    const seen: string[] = [];
    for (const row of table.rows) {
      const value = (row[column] ?? '').trim();
      if (value && !seen.includes(value)) {
        seen.push(value);
      }
      if (seen.length >= 50) {
        break;
      }
    }
    return seen;
  }, [draft.columns.type, table.rows]);

  const timeZone =
    draft.zoneChoice === OTHER_ZONE ? draft.zoneOther.trim() : draft.zoneChoice;

  const mapping: CsvMapping = useMemo(() => {
    const columns: CsvMapping['columns'] = {
      date: draft.columns.date ?? '',
      asset: draft.columns.asset ?? '',
      amount: draft.columns.amount ?? '',
    };
    for (const key of [
      'type',
      'fee',
      'feeAsset',
      'counterAsset',
      'counterAmount',
      'price',
      'tradeId',
      'txHash',
    ] as const) {
      if (draft.columns[key]) {
        columns[key] = draft.columns[key];
      }
    }
    const kinds: Record<string, EventKind> = {};
    if (columns.type) {
      for (const value of typeValues) {
        if (draft.kinds[value]) {
          kinds[value] = draft.kinds[value];
        }
      }
    } else if (draft.kinds['*']) {
      kinds['*'] = draft.kinds['*'];
    }
    return {
      version: 1,
      venueLabel: label.trim(),
      delimiter,
      columns,
      dateFormat: draft.dateFormat,
      timeZone,
      decimal: draft.decimal,
      direction:
        draft.mode === 'type'
          ? {
              mode: 'type',
              in: typeValues.filter((value) => draft.tags[value]?.in),
              out: typeValues.filter((value) => draft.tags[value]?.out),
            }
          : { mode: 'sign' },
      kinds,
      counter: draft.fiatCounter
        ? { kind: 'fiat', currency: draft.fiatCurrency }
        : { kind: 'column' },
    };
  }, [draft, label, delimiter, timeZone, typeValues]);

  const missing = missingColumns(mapping, table.header);
  const problems = [
    ...validateMapping(mapping),
    ...missing.map((name) => t('Column {{name}} is not in the file', { name })),
  ];
  const datesOk = useMemo(() => {
    const column = mapping.columns.date;
    if (!column) {
      return false;
    }
    const first = table.rows.slice(0, 5);
    return (
      first.length > 0 &&
      first.every(
        (row) =>
          parseMappedDate(row[column] ?? '', mapping.dateFormat, timeZone) !==
          undefined,
      )
    );
  }, [mapping.columns.date, mapping.dateFormat, table.rows, timeZone]);
  const valid =
    mapping.venueLabel !== '' &&
    timeZone !== '' &&
    problems.length === 0 &&
    datesOk;

  const preview = useMemo(
    () => (step === 3 ? previewMapped(text, mapping) : null),
    [step, text, mapping],
  );

  const patch = (next: Partial<Draft>) => {
    setTouched(true);
    setDraft((previous) => ({ ...previous, ...next }));
  };

  const tag = (value: string, direction: 'in' | 'out') => {
    setTouched(true);
    setDraft((previous) => {
      const current = previous.tags[value] ?? {};
      return {
        ...previous,
        // Exclusive: tagging one direction clears the other.
        tags: {
          ...previous.tags,
          [value]:
            direction === 'in'
              ? { in: !current.in, out: false }
              : { in: false, out: !current.out },
        },
      };
    });
  };

  const runImport = async () => {
    if (!file) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onImport(text, mapping, file.name, {
        replaceExisting: savedVenue !== undefined && replaceExisting,
      });
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const describeEvent = (
    event: NonNullable<typeof preview>['sample'][number],
  ) =>
    t('{{kind}} on {{date}}: {{legs}}', {
      kind: event.kind,
      date: new Date(event.timestamp).toISOString().slice(0, 10),
      legs: event.legs
        .map(
          (leg) =>
            `${leg.direction === 'in' ? '+' : '-'}${leg.amount} ${leg.assetId.split(':').pop()?.toUpperCase()}`,
        )
        .join(', '),
    });

  const skippedCount = preview?.skipped.length ?? 0;
  const eventCount = preview
    ? Object.values(preview.byKind).reduce((a, b) => a + b, 0)
    : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('Map the columns')}</DialogTitle>
          <DialogDescription>{t('Other CSV')}</DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor="map-csv-label" className="text-sm font-medium">
                {t('Venue label')}
              </label>
              <Input
                id="map-csv-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            {file ? (
              <div className="overflow-x-auto">
                <table className="text-xs">
                  <thead>
                    <tr>
                      {table.header.map((name) => (
                        <th
                          key={name}
                          scope="col"
                          className="px-2 py-1 text-left"
                        >
                          {name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.slice(0, 5).map((row, index) => (
                      <tr key={index}>
                        {table.header.map((name) => (
                          <td key={name} className="px-2 py-1">
                            {row[name]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <FileDropArea onFile={setFile} />
            )}
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {COLUMN_FIELDS.map(({ key, label: name, required }) => (
                <div key={key} className="flex flex-col gap-1">
                  <label htmlFor={`map-col-${key}`} className="text-sm">
                    {t(name)}
                    {required && <span aria-hidden="true"> *</span>}
                  </label>
                  <select
                    id={`map-col-${key}`}
                    aria-required={required ? 'true' : undefined}
                    className={SELECT_CLASS}
                    value={draft.columns[key] ?? ''}
                    onChange={(event) =>
                      patch({
                        columns: {
                          ...draft.columns,
                          [key]: event.target.value,
                        },
                      })
                    }
                  >
                    <option value="" />
                    {table.header.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium">
                {t('Date format')}
              </legend>
              <div className="flex flex-wrap gap-3">
                {DATE_FORMATS.map(({ value, label: name }) => (
                  <label
                    key={value}
                    className="flex items-center gap-1 text-sm"
                  >
                    <input
                      type="radio"
                      name="map-date-format"
                      checked={draft.dateFormat === value}
                      onChange={() => patch({ dateFormat: value })}
                    />
                    {t(name)}
                  </label>
                ))}
              </div>
              {!datesOk && mapping.columns.date && (
                <p className="text-xs text-destructive">
                  {t('The first dates do not fit this format and time zone')}
                </p>
              )}
            </fieldset>

            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="map-zone" className="text-sm font-medium">
                  {t('Time zone')}
                </label>
                <select
                  id="map-zone"
                  className={SELECT_CLASS}
                  value={draft.zoneChoice}
                  onChange={(event) =>
                    patch({ zoneChoice: event.target.value })
                  }
                >
                  {ZONES.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                  <option value={OTHER_ZONE}>{t('Other')}</option>
                </select>
              </div>
              {draft.zoneChoice === OTHER_ZONE && (
                <Input
                  aria-label={t('Other time zone')}
                  placeholder="America/New_York"
                  className="w-56"
                  value={draft.zoneOther}
                  onChange={(event) => patch({ zoneOther: event.target.value })}
                />
              )}
            </div>

            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium">
                {t('Decimal separator')}
              </legend>
              <div className="flex gap-3">
                {(['dot', 'comma'] as const).map((value) => (
                  <label
                    key={value}
                    className="flex items-center gap-1 text-sm"
                  >
                    <input
                      type="radio"
                      name="map-decimal"
                      checked={draft.decimal === value}
                      onChange={() => patch({ decimal: value })}
                    />
                    {value === 'dot' ? t('Dot') : t('Comma')}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium">{t('Direction')}</legend>
              <div className="flex gap-3">
                {(['sign', 'type'] as const).map((value) => (
                  <label
                    key={value}
                    className="flex items-center gap-1 text-sm"
                  >
                    <input
                      type="radio"
                      name="map-direction"
                      checked={draft.mode === value}
                      onChange={() => patch({ mode: value })}
                    />
                    {value === 'sign'
                      ? t('By sign of the amount')
                      : t('By type value')}
                  </label>
                ))}
              </div>
            </fieldset>

            {draft.columns.type ? (
              <ul className="flex flex-col gap-2">
                {typeValues.map((value) => (
                  <li key={value} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-24 rounded-full bg-muted px-2 py-0.5 text-sm">
                      {value}
                    </span>
                    {draft.mode === 'type' && (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant={
                            draft.tags[value]?.in ? 'default' : 'outline'
                          }
                          aria-pressed={draft.tags[value]?.in}
                          aria-label={`${t('Incoming')}: ${value}`}
                          onClick={() => tag(value, 'in')}
                        >
                          {t('Incoming')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={
                            draft.tags[value]?.out ? 'default' : 'outline'
                          }
                          aria-pressed={draft.tags[value]?.out}
                          aria-label={`${t('Outgoing')}: ${value}`}
                          onClick={() => tag(value, 'out')}
                        >
                          {t('Outgoing')}
                        </Button>
                      </>
                    )}
                    <select
                      aria-label={`${t('Kind')}: ${value}`}
                      className={SELECT_CLASS}
                      value={draft.kinds[value] ?? ''}
                      onChange={(event) =>
                        patch({
                          kinds: {
                            ...draft.kinds,
                            [value]: event.target.value as EventKind,
                          },
                        })
                      }
                    >
                      <option value="" />
                      {KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {t(KIND_LABELS[kind])}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex items-center gap-2">
                <label htmlFor="map-kind-all" className="text-sm">
                  {t('Kind')}
                </label>
                <select
                  id="map-kind-all"
                  className={SELECT_CLASS}
                  value={draft.kinds['*'] ?? ''}
                  onChange={(event) =>
                    patch({
                      kinds: {
                        ...draft.kinds,
                        '*': event.target.value as EventKind,
                      },
                    })
                  }
                >
                  <option value="" />
                  {KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(KIND_LABELS[kind])}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.fiatCounter}
                onChange={(event) =>
                  patch({ fiatCounter: event.target.checked })
                }
              />
              {t('Counter value is fiat')}
            </label>
            {draft.fiatCounter && (
              <div className="flex items-center gap-2">
                <label htmlFor="map-fiat-currency" className="text-sm">
                  {t('Fiat currency')}
                </label>
                <select
                  id="map-fiat-currency"
                  className={SELECT_CLASS}
                  value={draft.fiatCurrency}
                  onChange={(event) =>
                    patch({ fiatCurrency: event.target.value })
                  }
                >
                  {FIAT_CURRENCIES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {problems.map((problem) => (
              <p key={problem} className="text-xs text-destructive">
                {t(problem, { defaultValue: problem })}
              </p>
            ))}
          </div>
        )}

        {step === 3 && preview && (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">{t('Preview')}</p>
            <p className="text-sm">
              {t('{{count}} events', { count: eventCount })}
            </p>
            <p className="text-sm">
              {t('{{count}} skipped', { count: skippedCount })}
            </p>
            {skippedCount > 0 && (
              <ul className="list-disc pl-5 text-xs text-muted-foreground">
                {preview.skipped.slice(0, 5).map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            {preview.warnings.map((warning) => (
              <p
                key={warning}
                className="text-sm text-amber-600 dark:text-amber-400"
              >
                {t(warning)}
              </p>
            ))}
            {preview.unresolved.length > 0 && (
              <p className="text-sm">
                {t('Unresolved tickers: {{tickers}}', {
                  tickers: preview.unresolved.join(', '),
                })}
              </p>
            )}
            {savedVenue && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={replaceExisting}
                  onChange={(event) => setReplaceExisting(event.target.checked)}
                />
                {t("Replace this venue's existing events ({{count}})", {
                  count: savedVenue.count,
                })}
              </label>
            )}
            <ul className="flex flex-col gap-1 text-xs">
              {preview.sample.slice(0, 3).map((event, index) => (
                <li key={index}>{describeEvent(event)}</li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter className="flex flex-wrap gap-2">
          {step > 1 && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setStep((step - 1) as 1 | 2)}
            >
              {t('Back')}
            </Button>
          )}
          {step === 1 && (
            <Button
              type="button"
              disabled={!file || !text || label.trim() === ''}
              onClick={() => setStep(2)}
            >
              {t('Continue')}
            </Button>
          )}
          {step === 2 && (
            <Button type="button" disabled={!valid} onClick={() => setStep(3)}>
              {t('Preview')}
            </Button>
          )}
          {step === 3 && (
            <Button type="button" disabled={!valid || busy} onClick={runImport}>
              {t('Import')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
