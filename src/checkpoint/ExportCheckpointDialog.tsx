import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2Icon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  buildCheckpoint,
  chooseChannel,
  encodeQrPayload,
  generateTransferSecret,
  sealCheckpoint,
} from '@/checkpoint/format';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type Status = 'loading' | 'ready' | 'error';

/**
 * Both artifacts, sealed with ONE secret in one run.
 *
 * One object rather than four pieces of state, for the same reason the
 * secret is generated inside the sealing run: a re-render must never show
 * a secret that does not match the bytes on screen, and four separate
 * setStates are four chances to land out of step.
 */
type Ready = {
  secret: string;
  /** The handover, encoded - or null when it does not fit one code. */
  qrDataUrl: string | null;
  /** The full backup, for the file. */
  backup: Uint8Array;
  /** Recorded transactions the handover leaves behind. */
  omitted: number;
};

const checkpointFilename = (): string => {
  const date = new Date().toISOString().slice(0, 10);
  return `coineda-checkpoint-${date}.coineda`;
};

/**
 * Builds, seals and hands over a fresh checkpoint, every time this dialog
 * is opened: a QR code when the payload fits one, and a file download
 * always. Both, because they answer different situations - the code is for
 * two devices in the same room, the file for a device that is not. This is the only place in the app that can produce a checkpoint -
 * Task 9 built the whole sealing pipeline and Task 10 built the import
 * side, but neither of them gave the user a way to actually create one.
 *
 * The transfer secret is generated exactly once per open, inside the same
 * async run that seals the checkpoint with it, and both land in state
 * together at the end of that run. Deriving the secret separately - e.g. a
 * `useState` initializer, or worse, inline at render time - risks a
 * re-render showing a secret that does not match the bytes already sealed
 * into the QR/file on screen: the user would then type exactly what the
 * dialog showed and be told it was wrong, with no way to tell why.
 */
export const ExportCheckpointDialog = ({ open, onOpenChange }: Props) => {
  const { t } = useTranslation();

  const [status, setStatus] = useState<Status>('loading');
  const [ready, setReady] = useState<Ready | null>(null);
  // Bumped by the "Try again" button to re-run the effect below without
  // requiring the dialog to be closed and reopened first.
  const [attempt, setAttempt] = useState(0);

  // Resets to the loading state the moment this dialog (re)opens or a retry
  // is requested - done during render by comparing against the previous
  // open/attempt pair, the same "adjusting state when a prop changes"
  // pattern AddSourceDialog uses, rather than a `setState` call sitting
  // synchronously at the top of the effect below (which react-hooks flags:
  // an effect's synchronous body should only read from React state, not
  // write it back before any async work has even started).
  const [prevRun, setPrevRun] = useState(`${open}:${attempt}`);
  const run = `${open}:${attempt}`;
  if (run !== prevRun) {
    setPrevRun(run);
    if (open) {
      setStatus('loading');
      setReady(null);
    }
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    // `cancelled` covers both an unmount and the dialog being closed (or a
    // new attempt starting) while the build is still in flight: none of
    // those should let a stale async result land in state after the fact.
    let cancelled = false;

    (async () => {
      try {
        // Both scopes, so the dialog can offer both at once: the handover
        // is what fits a code, the backup is what survives a dead source.
        const [handover, backup] = await Promise.all([
          buildCheckpoint('handover'),
          buildCheckpoint('backup'),
        ]);
        // Generated and sealed together, in this one run - see the doc
        // comment above. One secret for both artifacts: two would be two
        // things to type correctly and no more secure.
        const transferSecret = generateTransferSecret();
        const [sealedHandover, sealedBackup] = await Promise.all([
          sealCheckpoint(handover, transferSecret),
          sealCheckpoint(backup, transferSecret),
        ]);

        // Encoded only when it fits: `chooseChannel` returning 'file'
        // means this payload does not, and a QR is never truncated to
        // make one - a truncated code scans back into a partial setup
        // that looks complete. A handover usually fits; one carrying a
        // long history of hand-entered events may not, and then the file
        // is the only way offered.
        const dataUrl =
          chooseChannel(sealedHandover).channel === 'qr'
            ? await encodeQrPayload(sealedHandover)
            : null;

        if (cancelled) {
          return;
        }
        setReady({
          secret: transferSecret,
          qrDataUrl: dataUrl,
          backup: sealedBackup,
          omitted: handover.omittedEventCount ?? 0,
        });
        setStatus('ready');
      } catch {
        if (!cancelled) {
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, attempt]);

  const handleDownload = () => {
    if (!ready) {
      return;
    }
    // Re-wrapped: TS 5's updated typed-array lib types the sealed bytes as
    // `Uint8Array<ArrayBufferLike>`, which `BlobPart` (an
    // `ArrayBufferView<ArrayBuffer>`) does not accept as-is. `new
    // Uint8Array(...)` always allocates a fresh, plain `ArrayBuffer`
    // backing store, so the copy's type narrows to what `Blob` wants.
    const blob = new Blob([new Uint8Array(ready.backup)]);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = checkpointFilename();
    anchor.click();
    URL.revokeObjectURL(url);
  };

  /**
   * The secret, wherever it belongs on screen.
   *
   * It is needed by whichever artifact the user reaches for, so it sits
   * next to the code when there is one and on its own when there is not -
   * never once per artifact, which would read as two different secrets.
   */
  const transferSecret = ready && (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="text-sm font-medium">{t('Transfer secret')}</h4>
      <p className="rounded-md bg-muted px-3 py-2 text-center font-mono text-lg tracking-widest select-all">
        {ready.secret}
      </p>
      <p className="text-sm text-muted-foreground">
        {t(
          'This secret travels with neither the code nor the file. Type it on your other device too - without it, what you send over is useless.',
        )}
      </p>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Wider than the default dialog so the code and the secret fit
          side by side rather than stacking into a scroll. */}
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('Create checkpoint')}</DialogTitle>
          <DialogDescription>
            {t(
              'A checkpoint carries your settings, your data sources and every transaction recorded here - so you can set up another device, and so your history outlives a data source that one day no longer exists.',
            )}
          </DialogDescription>
        </DialogHeader>

        {status === 'loading' && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2Icon
              className="size-6 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground">
              {t('Creating your checkpoint…')}
            </p>
          </div>
        )}

        {status === 'error' && (
          <p className="text-sm text-destructive" role="alert">
            {t('Could not create a checkpoint. Try again.')}
          </p>
        )}

        {status === 'ready' && ready && (
          <div className="flex flex-col gap-6">
            {/* The handover. First, because it is the case where the two
                devices are in the same room - and the one a code can
                actually serve. */}
            {ready.qrDataUrl !== null && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <h3 className="text-sm font-medium">
                    {t('Set up another device')}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {t(
                      'Scan this on your other device, then type the transfer secret below into it. It carries your settings, your data sources and anything you entered yourself.',
                    )}
                  </p>
                  {ready.omitted > 0 && (
                    // Said here rather than only on the other device: a
                    // person who knows what the code leaves behind can
                    // decide to use the file instead, before scanning.
                    <p className="text-sm text-muted-foreground">
                      {t(
                        'Your {{count}} recorded transactions do not fit a code and stay behind. The other device fetches them from your sources itself.',
                        { count: ready.omitted },
                      )}
                    </p>
                  )}
                </div>
                {/* Code and secret in one row, because they are one
                    instruction: scan this, then type that. Stacked, the
                    code alone filled the dialog and the secret sat below
                    the fold - so someone who had never heard of a
                    transfer secret scanned the code, was asked for one on
                    their phone, and had no idea the screen in front of
                    them was showing it. */}
                <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
                  <img
                    src={ready.qrDataUrl}
                    alt={t('Checkpoint QR code')}
                    // 288px, not smaller: a checkpoint close to the QR byte
                    // limit encodes as a version-40 code, 177 modules
                    // across, and shrinking it to make room would put a
                    // module under two device pixels and stop it
                    // scanning.
                    className="h-auto w-full max-w-72 shrink-0 rounded-md sm:w-72"
                  />
                  {transferSecret}
                </div>
              </div>
            )}

            {/* The backup. Always, and never a mere fallback: it is the
                only artifact that outlives the sources it came from. */}
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-medium">{t('Keep a backup')}</h3>
                <p className="text-sm text-muted-foreground">
                  {ready.qrDataUrl === null
                    ? t(
                        'This checkpoint is too large for a code, so it comes as a file. It carries everything, including every recorded transaction.',
                      )
                    : t(
                        'A file carrying everything, including every recorded transaction - so your history is still here if a data source one day is not.',
                      )}
                </p>
              </div>
              <Button
                type="button"
                variant={ready.qrDataUrl === null ? 'default' : 'outline'}
                className="max-w-xs"
                onClick={handleDownload}
              >
                {t('Download checkpoint')}
              </Button>
            </div>

            {/* No code to sit beside: the file is the only route, and
                the secret belongs under it. */}
            {ready.qrDataUrl === null && transferSecret}
          </div>
        )}

        <DialogFooter>
          {status === 'error' && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setAttempt((n) => n + 1)}
            >
              {t('Try again')}
            </Button>
          )}
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t('Done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
