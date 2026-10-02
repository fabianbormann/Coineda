import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2Icon, TriangleAlertIcon, DownloadIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { getAllEvents } from '@/ledger/db';
import { getSettings } from '@/settings/settingsStore';
import { buildJourneySeries } from './series';
import type { JourneySeries } from './series';
import { renderJourneyFrame } from './render';
import type { JourneyLabels, JourneyMode } from './render';
import { recordVideo } from './recordVideo';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type Status = 'loading' | 'ready' | 'error';

const DEFAULT_CURRENCY = 'eur';
const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 540;
/** How long one loop of the live preview takes to sweep the whole series. */
const PREVIEW_DURATION_MS = 6000;
/** How long the exported clip runs - a single, non-looping sweep. */
const EXPORT_DURATION_MS = 6000;

const journeyFilename = (): string => {
  const date = new Date().toISOString().slice(0, 10);
  return `coineda-journey-${date}.webm`;
};

/** A canvas with the non-standard (but universally implemented)
 *  `captureStream` method, which lib.dom.ts does not declare. */
type CapturableCanvas = HTMLCanvasElement & {
  captureStream: (frameRate?: number) => MediaStream;
};

/**
 * The shareable crypto-history video: builds the journey series once per
 * open, then lets the owner preview it live on a canvas and, on request,
 * record a fixed-length `.webm` clip of it.
 *
 * Two modes, picked before recording: 'relative' (the default) expresses
 * every value as a percentage of today's total and never draws an absolute
 * figure anywhere - see src/journey/render.ts's `scaleSeries`, which is
 * where that guarantee actually lives - so the owner can post it without
 * revealing their net worth. 'absolute' draws the real base-currency
 * values, for a clip kept private.
 *
 * The series build does one historical price lookup per (asset, month)
 * pair and can therefore take a while on a real portfolio; the dialog
 * shows a pending state for it and, on failure, stays open with the
 * message shown rather than closing on the owner.
 */
export const JourneyDialog = ({ open, onOpenChange }: Props) => {
  const { t, i18n } = useTranslation();

  const [status, setStatus] = useState<Status>('loading');
  const [buildError, setBuildError] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [series, setSeries] = useState<JourneySeries | null>(null);
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [mode, setMode] = useState<JourneyMode>('relative');
  const [recording, setRecording] = useState(false);
  // Bumped by "Try again" to re-run the build effect below without closing
  // and reopening the dialog first - the same shape
  // ExportCheckpointDialog's `attempt` uses.
  const [attempt, setAttempt] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewFrameRef = useRef<number | null>(null);

  // Reset to the loading state every time this dialog (re)opens - the same
  // "adjusting state when a prop changes" pattern AddSourceDialog and
  // ExportCheckpointDialog use, done during render so a stale series or
  // mode from a previous open can never flash first.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setStatus('loading');
      setBuildError(null);
      setRecordError(null);
      setSeries(null);
      setMode('relative');
      setRecording(false);
    }
  }

  // Builds the series. Every `setState` below happens only after an
  // `await`, inside the async run's own continuation - never synchronously
  // in the effect body - so a dialog closed (or retried) while the build is
  // still in flight cannot have a stale result land in its state.
  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const [events, settings] = await Promise.all([
          getAllEvents(),
          getSettings(),
        ]);
        const baseCurrency = settings?.baseCurrency ?? DEFAULT_CURRENCY;
        const built = await buildJourneySeries(events, baseCurrency, {
          apiKey: settings?.coingeckoApiKey,
        });
        if (cancelled) {
          return;
        }
        setSeries(built);
        setCurrency(baseCurrency);
        setStatus('ready');
      } catch (caught) {
        if (!cancelled) {
          setBuildError(
            caught instanceof Error ? caught.message : String(caught),
          );
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, attempt]);

  // The live preview loop: redraws every frame, looping progress 0..1 over
  // PREVIEW_DURATION_MS, for as long as the dialog is ready, not
  // recording, and has a canvas to draw on. Paused during `recording` so
  // the export's own single sweep (in handleRecord) is the only thing
  // drawing to the canvas while MediaRecorder is capturing it.
  useEffect(() => {
    if (status !== 'ready' || !series || recording) {
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const labels: JourneyLabels = {
      title: t('Your crypto journey'),
      acquisitionPrefix: t('Bought'),
      noDataLabel: t('Not enough priced history yet'),
    };

    const startedAt = performance.now();
    const tick = (now: number) => {
      const elapsed = (now - startedAt) % PREVIEW_DURATION_MS;
      renderJourneyFrame(ctx, series, {
        mode,
        progress: elapsed / PREVIEW_DURATION_MS,
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        currency,
        language: i18n.language,
        labels,
      });
      previewFrameRef.current = requestAnimationFrame(tick);
    };
    previewFrameRef.current = requestAnimationFrame(tick);

    return () => {
      if (previewFrameRef.current !== null) {
        cancelAnimationFrame(previewFrameRef.current);
        previewFrameRef.current = null;
      }
    };
  }, [status, series, mode, recording, currency, i18n.language, t]);

  const handleRecord = async () => {
    const canvas = canvasRef.current;
    if (!series || !canvas) {
      return;
    }
    setRecording(true);
    setRecordError(null);

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setRecordError(t('Could not access the canvas'));
      setRecording(false);
      return;
    }

    const labels: JourneyLabels = {
      title: t('Your crypto journey'),
      acquisitionPrefix: t('Bought'),
      noDataLabel: t('Not enough priced history yet'),
    };

    // captureStream() is obtained HERE, not inside recordVideo(), so a test
    // can stub it on the canvas and assert recordVideo was called with
    // exactly the stream it produced.
    const stream = (canvas as CapturableCanvas).captureStream(30);
    let exportFrame: number | null = null;

    try {
      const startedAt = performance.now();
      const drive = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / EXPORT_DURATION_MS);
        renderJourneyFrame(ctx, series, {
          mode,
          progress,
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
          currency,
          language: i18n.language,
          labels,
        });
        if (progress < 1) {
          exportFrame = requestAnimationFrame(drive);
        }
      };
      exportFrame = requestAnimationFrame(drive);

      const blob = await recordVideo(stream, EXPORT_DURATION_MS);

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = journeyFilename();
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setRecordError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (exportFrame !== null) {
        cancelAnimationFrame(exportFrame);
      }
      stream.getTracks().forEach((track) => track.stop());
      setRecording(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('Your crypto journey')}</DialogTitle>
          <DialogDescription>
            {t(
              'A shareable look at your portfolio over time. Shareable mode never shows an absolute amount, so you can post it without revealing your balance.',
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
              {t(
                'Building your journey… this can take a while because historical prices are looked up one at a time.',
              )}
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col gap-3 py-4">
            <p
              className="flex items-center gap-2 text-sm text-destructive"
              role="alert"
            >
              <TriangleAlertIcon
                className="size-4 shrink-0"
                aria-hidden="true"
              />
              {t('Could not build your journey: {{detail}}', {
                detail: buildError ?? '',
              })}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAttempt((n) => n + 1)}
            >
              {t('Try again')}
            </Button>
          </div>
        )}

        {status === 'ready' && series && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={mode === 'relative' ? 'default' : 'outline'}
                onClick={() => setMode('relative')}
                disabled={recording}
              >
                {t('Shareable (hide my balance)')}
              </Button>
              <Button
                type="button"
                variant={mode === 'absolute' ? 'default' : 'outline'}
                onClick={() => setMode('absolute')}
                disabled={recording}
              >
                {t('Full detail (show my balance)')}
              </Button>
            </div>
            <canvas
              ref={canvasRef}
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              className="w-full rounded-md border bg-black"
            />
            {recordError && (
              <p className="text-sm text-destructive" role="alert">
                {t('Could not record your video: {{detail}}', {
                  detail: recordError,
                })}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            onClick={handleRecord}
            disabled={status !== 'ready' || recording}
          >
            {recording ? (
              <>
                <Loader2Icon
                  className="size-4 animate-spin"
                  aria-hidden="true"
                />
                {t('Recording…')}
              </>
            ) : (
              <>
                <DownloadIcon className="size-4" aria-hidden="true" />
                {t('Record and download')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
