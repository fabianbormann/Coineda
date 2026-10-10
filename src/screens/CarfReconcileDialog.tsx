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
import { FileDropArea } from '@/components/files/FileDropArea';
import { aggregateLedger } from '@/carf/aggregate';
import { labelOfCode } from '@/carf/codes';
import { guessProviderSources, isProviderSource } from '@/carf/guessSources';
import { sha256Hex } from '@/carf/hash';
import { CarfParseError, parseCarf } from '@/carf/parse';
import { reconcile, type CarfReconciliation } from '@/carf/reconcile';
import type { CarfMessage, CarfUser } from '@/carf/types';
import type { LedgerEvent, SourceRecord } from '@/ledger/types';
import { findModule } from '@/sources/registry';
import type { SourceDirectoryEntry } from '@/tax/sourceDirectory';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The report's tax year; a message for another year is refused. */
  taxYear: number;
  baseCurrency: string;
  sources: SourceRecord[];
  /** The report's source directory: venues per source. */
  directory: SourceDirectoryEntry[];
  /** The linked ledger events (manual transfer links applied). */
  events: LedgerEvent[];
  /** The register value of an event's leg in an asset, base currency. */
  valueOf: (sourceEventId: string, assetId: string) => string | undefined;
  /** The client's `taxpayer.taxNumber`, for preselecting the user. */
  taxNumber?: string;
  onReconciled: (reconciliation: CarfReconciliation) => void;
};

/** A message to show, as a translation key and its values. */
type Problem = { key: string; params?: Record<string, string> };

const DELETED = 'OECD3';

/** TINs and the tax-number setting are free text: compared without
 *  whitespace and slashes, so `12/345/678/901` meets `12 345 678 901`. */
const normaliseTin = (value: string): string => value.replace(/[\s/]/g, '');

/**
 * The bytes as text. A UTF-16 file announces itself with a byte order
 * mark; everything else is read as UTF-8 (the CARF schema's encoding).
 */
const decode = (bytes: Uint8Array): string => {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes);
  }
  return new TextDecoder().decode(bytes);
};

const preselectUser = (users: CarfUser[], taxNumber?: string): number => {
  const wanted = normaliseTin(taxNumber ?? '');
  const comparable = users
    .map((user, index) => ({ user, index }))
    .filter(({ user }) => user.docTypeIndic !== DELETED);
  if (wanted !== '') {
    const byTin = comparable.find(({ user }) =>
      user.tins.some((tin) => normaliseTin(tin.value) === wanted),
    );
    if (byTin) return byTin.index;
  }
  return comparable[0]?.index ?? -1;
};

/**
 * Compares a provider's CARF (DAC8) report with the ledger, in two steps:
 * the file, then who in it is the client and which sources stand for the
 * provider. The file and the parsed message live only in this dialog's
 * state; what leaves it is the reconciliation the report section shows.
 */
export const CarfReconcileDialog = ({
  open,
  onOpenChange,
  taxYear,
  baseCurrency,
  sources,
  directory,
  events,
  valueOf,
  taxNumber,
  onReconciled,
}: Props) => {
  const { t } = useTranslation();

  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [message, setMessage] = useState<CarfMessage | null>(null);
  const [userIndex, setUserIndex] = useState(-1);
  const [selected, setSelected] = useState<string[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);

  const providerSources = useMemo(
    () => sources.filter((source) => isProviderSource(source)),
    [sources],
  );

  // Start over each time the dialog is (re)opened, while rendering, so a
  // previous file never flashes.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setFile(null);
      setText('');
      setMessage(null);
      setUserIndex(-1);
      setSelected([]);
      setProblem(null);
      setBusy(false);
    }
  }

  // Read and parse the chosen file.
  useEffect(() => {
    if (!file) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const read = decode(new Uint8Array(await file.arrayBuffer()));
        const parsed = parseCarf(read);
        if (cancelled) return;
        if (parsed.year !== taxYear) {
          setProblem({
            key: 'This message is for {{year}}; the report is for {{taxYear}}.',
            params: { year: String(parsed.year), taxYear: String(taxYear) },
          });
          return;
        }
        setText(read);
        setMessage(parsed);
        setUserIndex(preselectUser(parsed.users, taxNumber));
        setSelected(
          guessProviderSources(parsed.provider.name, providerSources),
        );
      } catch (failure: unknown) {
        if (cancelled) return;
        setProblem(
          failure instanceof CarfParseError
            ? { key: failure.key, params: failure.params }
            : { key: 'The file could not be read.' },
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, taxYear, taxNumber, providerSources]);

  const choose = (next: File) => {
    setProblem(null);
    setMessage(null);
    setText('');
    setFile(next);
  };

  const startOver = () => {
    setFile(null);
    setText('');
    setMessage(null);
    setUserIndex(-1);
    setSelected([]);
    setProblem(null);
  };

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id)
        ? current.filter((other) => other !== id)
        : [...current, id],
    );

  const user = message && userIndex >= 0 ? message.users[userIndex] : null;
  const canCompare =
    !busy &&
    user !== null &&
    user.docTypeIndic !== DELETED &&
    selected.length > 0;

  const compare = async () => {
    if (!message || !user || !canCompare) {
      return;
    }
    setBusy(true);
    try {
      const chosen = providerSources.filter((source) =>
        selected.includes(source.id),
      );
      const chosenIds = new Set(chosen.map((source) => source.id));
      const providerVenues = new Set(
        directory
          .filter(
            (entry) => entry.sourceId !== null && chosenIds.has(entry.sourceId),
          )
          .flatMap((entry) => entry.venues),
      );
      const ownedVenues = new Set(directory.flatMap((entry) => entry.venues));
      const walletVenues = new Set(
        directory
          .filter(
            (entry) =>
              entry.moduleId !== null &&
              findModule(entry.moduleId)?.manifest.kind === 'chain',
          )
          .flatMap((entry) => entry.venues),
      );
      const own = aggregateLedger(events, {
        year: taxYear,
        providerVenues,
        ownedVenues,
        walletVenues,
        valueOf,
      });
      const fileHash = await sha256Hex(text);
      onReconciled(
        reconcile({
          message,
          user,
          own,
          baseCurrency,
          fileHash,
          sources: chosen.map(({ id, label }) => ({ id, label })),
        }),
      );
      onOpenChange(false);
    } catch (failure: unknown) {
      console.error('The CARF reconciliation failed', failure);
      setProblem({ key: 'The comparison could not be completed.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('Reconcile with a CARF report')}</DialogTitle>
          <DialogDescription>
            {message
              ? t('{{provider}} · reporting period {{period}}', {
                  provider: message.provider.name,
                  period: message.reportingPeriod,
                })
              : t(
                  'Choose the CARF XML file a provider reported to the tax office for {{year}}. It is read on this device and not stored.',
                  { year: taxYear },
                )}
          </DialogDescription>
        </DialogHeader>

        {!message ? (
          <div className="flex flex-col gap-3">
            <FileDropArea
              accept=".xml,text/xml,application/xml"
              onFile={choose}
            />
            {file && !problem && (
              <p className="text-sm text-muted-foreground">{file.name}</p>
            )}
            {problem && (
              <p role="alert" className="text-sm text-destructive">
                {t(problem.key, problem.params)}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {t('Message type')}: {t(labelOfCode(message.messageTypeIndic))} (
              {message.messageTypeIndic}) · MessageRefId:{' '}
              <span className="break-all">{message.messageRefId}</span>
            </p>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">
                {t('Who in this report is the client?')}
              </legend>
              {message.users.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t('This message lists no user.')}
                </p>
              )}
              {message.users.map((candidate, index) => {
                const deleted = candidate.docTypeIndic === DELETED;
                const id = `carf-user-${index}`;
                return (
                  <div key={id} className="flex items-start gap-2 text-sm">
                    <input
                      id={id}
                      type="radio"
                      name="carf-user"
                      className="mt-1"
                      checked={userIndex === index}
                      disabled={deleted}
                      onChange={() => setUserIndex(index)}
                    />
                    <label htmlFor={id} className="flex flex-col">
                      <span className="font-medium">
                        {candidate.name}
                        {deleted && (
                          <span className="ml-2 rounded-full border px-2 py-0.5 text-xs font-normal">
                            {t(labelOfCode(DELETED))}
                          </span>
                        )}
                      </span>
                      <span className="text-muted-foreground">
                        {candidate.tins.length > 0 &&
                          `${t('TIN')}: ${candidate.tins
                            .map((tin) => tin.value)
                            .join(', ')} · `}
                        DocRefId: {candidate.docRefId}
                      </span>
                    </label>
                  </div>
                );
              })}
            </fieldset>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">
                {t('Which sources are {{provider}}?', {
                  provider: message.provider.name,
                })}
              </legend>
              {providerSources.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t(
                    'This client has no exchange or file source to compare with.',
                  )}
                </p>
              ) : (
                providerSources.map((source) => {
                  const id = `carf-source-${source.id}`;
                  return (
                    <div key={source.id} className="flex items-center gap-2">
                      <input
                        id={id}
                        type="checkbox"
                        checked={selected.includes(source.id)}
                        onChange={() => toggle(source.id)}
                      />
                      <label htmlFor={id} className="text-sm">
                        {source.label}
                        <span className="ml-2 text-muted-foreground">
                          {source.moduleId}
                        </span>
                      </label>
                    </div>
                  );
                })
              )}
              <p className="text-xs text-muted-foreground">
                {t(
                  'Wallet sources are not listed: a provider reports only what happened in its own accounts.',
                )}
              </p>
            </fieldset>

            {problem && (
              <p role="alert" className="text-sm text-destructive">
                {t(problem.key, problem.params)}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {message ? (
            <>
              <Button type="button" variant="ghost" onClick={startOver}>
                {t('Back')}
              </Button>
              <Button
                type="button"
                disabled={!canCompare}
                onClick={() => void compare()}
              >
                {t('Compare')}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t('Cancel')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
