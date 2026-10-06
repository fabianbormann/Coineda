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
type Channel = 'qr' | 'file';

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
  const [channel, setChannel] = useState<Channel | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [sealedBytes, setSealedBytes] = useState<Uint8Array | null>(null);
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
      setChannel(null);
      setSecret(null);
      setQrDataUrl(null);
      setSealedBytes(null);
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
        const checkpoint = await buildCheckpoint();
        // Generated and sealed together, in this one run - see the doc
        // comment above.
        const transferSecret = generateTransferSecret();
        const sealed = await sealCheckpoint(checkpoint, transferSecret);
        const { channel: chosenChannel } = chooseChannel(sealed);

        // Encoded only when it fits: `chooseChannel` returning 'file'
        // means this payload does not, and a QR is never truncated to
        // make it - a truncated code scans back into a partial setup
        // that looks complete.
        const dataUrl =
          chosenChannel === 'qr' ? await encodeQrPayload(sealed) : null;

        if (cancelled) {
          return;
        }
        setQrDataUrl(dataUrl);
        // Kept whatever the channel. The file is not a fallback for a
        // checkpoint too big to scan - it is the way to move one between
        // two devices that are not in the same room, so it is offered
        // alongside the code rather than instead of it.
        setSealedBytes(sealed);
        setSecret(transferSecret);
        setChannel(chosenChannel);
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
    if (!sealedBytes) {
      return;
    }
    // Re-wrapped: TS 5's updated typed-array lib types `sealedBytes` as
    // `Uint8Array<ArrayBufferLike>`, which `BlobPart` (an
    // `ArrayBufferView<ArrayBuffer>`) does not accept as-is. `new
    // Uint8Array(...)` always allocates a fresh, plain `ArrayBuffer`
    // backing store, so the copy's type narrows to what `Blob` wants.
    const blob = new Blob([new Uint8Array(sealedBytes)]);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = checkpointFilename();
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Create checkpoint')}</DialogTitle>
          <DialogDescription>
            {t(
              'A checkpoint carries your settings, your data sources and anything you entered yourself, so you can set up another device.',
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

        {status === 'ready' && secret && (
          <div className="flex flex-col gap-4">
            {channel === 'qr' && qrDataUrl ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {t(
                    'Scan this QR code on your other device, then type the transfer secret below into it.',
                  )}
                </p>
                <img
                  src={qrDataUrl}
                  alt={t('Checkpoint QR code')}
                  className="mx-auto h-auto w-full max-w-xs"
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t(
                  'This checkpoint is too large for a QR code, so it comes as a file. Send the file to your other device, then type the transfer secret below into it.',
                )}
              </p>
            )}

            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant={channel === 'qr' ? 'outline' : 'default'}
                className="max-w-xs"
                onClick={handleDownload}
              >
                {t('Download checkpoint')}
              </Button>
              {channel === 'qr' && (
                <p className="text-sm text-muted-foreground">
                  {t(
                    'Or download it as a file, if the other device is not in front of you.',
                  )}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <p className="rounded-md bg-muted px-3 py-2 text-center font-mono text-lg tracking-widest select-all">
                {secret}
              </p>
              <p className="text-sm text-muted-foreground">
                {t(
                  'This secret travels with neither the code nor the file. Type it on your other device too - without it, what you send over is useless.',
                )}
              </p>
            </div>
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
