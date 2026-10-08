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
import { getLinkedEvents } from '@/ledger/manualLinks';
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
/** How long the playhead takes to travel from the first event to today. */
const SWEEP_MS = 7000;
/** How long the settled pile and the closing figure stay on screen after
 *  the sweep. Without this the clip ended on the frame the last coin
 *  landed, and the total the whole thing builds up to was never seen. */
const HOLD_MS = 2500;
/** One full play, preview loop and exported clip alike. */
const CLIP_MS = SWEEP_MS + HOLD_MS;

/** Where in the clip `elapsed` falls: a 0..1 sweep, then held at 1. */
const progressAt = (elapsedMs: number): number =>
  Math.min(1, Math.max(0, elapsedMs / SWEEP_MS));

const journeyFilename = (): string => {
  const date = new Date().toISOString().slice(0, 10);
  return `coineda-journey-${date}.webm`;
};

/** The frame's chrome, translated once per draw loop rather than per
 *  frame. Passed in so render.ts never needs i18n to be testable. */
const labelsOf = (t: (key: string) => string): JourneyLabels => ({
  title: t('Your crypto journey'),
  noDataLabel: t('No transactions to show yet'),
  moreAssets: t('and {{count}} more assets'),
  todayLabel: t('value today'),
});

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
 * Two modes, picked before recording: 'relative' (the default) names
 * assets, dates and counts but never a quantity or a fiat figure - see
 * src/journey/render.ts, where that guarantee actually lives - so the
 * owner can post it without revealing their holdings. 'absolute' adds the
 * quantities and the closing total, for a clip kept private.
 *
 * The series build makes one spot-price request (for the closing total
 * and the legend order) and no historical lookups; on failure the dialog
 * stays open with the message shown rather than closing on the owner.
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
          getLinkedEvents(),
          getSettings(),
        ]);
        const baseCurrency = settings?.baseCurrency ?? DEFAULT_CURRENCY;
        const built = await buildJourneySeries(events, baseCurrency, {});
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

  // The live preview loop: redraws every frame, looping one whole clip
  // (sweep, then hold) for as long as the dialog is ready, not recording,
  // and has a canvas to draw on. Paused during `recording` so
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

    const labels = labelsOf(t);

    const startedAt = performance.now();
    const tick = (now: number) => {
      const elapsed = (now - startedAt) % CLIP_MS;
      renderJourneyFrame(ctx, series, {
        mode,
        progress: progressAt(elapsed),
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

    const labels = labelsOf(t);

    // captureStream() is obtained HERE, not inside recordVideo(), so a test
    // can stub it on the canvas and assert recordVideo was called with
    // exactly the stream it produced.
    const stream = (canvas as CapturableCanvas).captureStream(30);
    let exportFrame: number | null = null;

    try {
      const startedAt = performance.now();
      // Keeps drawing through the hold, not only until progress reaches
      // 1: a captured stream only carries frames that were actually
      // painted, so a canvas left untouched for the last seconds would
      // give the recorder nothing to encode for them.
      const drive = (now: number) => {
        const elapsed = now - startedAt;
        renderJourneyFrame(ctx, series, {
          mode,
          progress: progressAt(elapsed),
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
          currency,
          language: i18n.language,
          labels,
        });
        if (elapsed < CLIP_MS) {
          exportFrame = requestAnimationFrame(drive);
        }
      };
      exportFrame = requestAnimationFrame(drive);

      const blob = await recordVideo(stream, CLIP_MS);

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
              'Every purchase drops into the jar, every sale lifts back out, along a timeline of your history. Shareable mode never shows an amount, so you can post it without revealing your balance.',
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
              {t('Building your journey…')}
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
