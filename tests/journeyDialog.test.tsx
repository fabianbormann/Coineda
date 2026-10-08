import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import i18n from '@/i18n';
import { openLedger } from '@/ledger/db';
import { putSettings } from '@/settings/settingsStore';
import { JourneyDialog } from '@/journey/JourneyDialog';
import { recordVideo } from '@/journey/recordVideo';
import { buildJourneySeries } from '@/journey/series';
import type { JourneySeries } from '@/journey/series';

// recordVideo itself wraps MediaRecorder, which jsdom does not implement -
// per src/journey/recordVideo.ts's own doc comment, its real body is never
// meant to run under test. What IS worth proving here is the boundary
// right before it: that the dialog obtains a MediaStream from the canvas
// and hands that exact stream to recordVideo - the series build and the
// relative-mode scaling (the parts that can actually be wrong) are covered
// directly in tests/journeySeries.test.ts and tests/journeyRender.test.ts.
vi.mock('@/journey/recordVideo', () => ({
  recordVideo: vi.fn(),
}));

// buildJourneySeries is mocked so the "fails to build" test can force a
// genuine rejection on demand, rather than needing a real network failure
// that the real implementation already degrades to an unpriced point
// instead of throwing.
vi.mock('@/journey/series', () => ({
  buildJourneySeries: vi.fn(),
}));

const recordVideoMock = vi.mocked(recordVideo);
const buildJourneySeriesMock = vi.mocked(buildJourneySeries);

const readySeries: JourneySeries = {
  points: [
    {
      timestamp: Date.UTC(2025, 0, 1),
      holdings: [{ assetId: 'cardano:lovelace', amount: '10000000' }],
    },
  ],
  acquisitions: [],
  disposals: [],
  assets: ['cardano:lovelace'],
  finalValue: '20',
  prices: { 'cardano:lovelace': '0.5' },
};

beforeEach(async () => {
  const db = await openLedger();
  for (const store of [
    'events',
    'sources',
    'cursors',
    'settings',
    'prices',
  ] as const) {
    await db.clear(store);
  }
  await putSettings({ language: 'en', baseCurrency: 'eur' });
  await i18n.changeLanguage('en');

  // jsdom has no 2D canvas backend: getContext('2d') returns null. render.ts
  // only ever calls the handful of drawing methods below, so a plain
  // recording stub (the same shape tests/journeyRender.test.ts uses) is
  // enough to let the dialog's real draw/record code path run at all.
  const fakeCtx = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeCtx as unknown as CanvasRenderingContext2D,
  );

  buildJourneySeriesMock.mockReset();
  buildJourneySeriesMock.mockResolvedValue(readySeries);

  recordVideoMock.mockReset();
  recordVideoMock.mockResolvedValue(new Blob(['x'], { type: 'video/webm' }));
});

describe('JourneyDialog', () => {
  it('passes the stream from canvas.captureStream() straight to recordVideo()', async () => {
    // HTMLCanvasElement.captureStream does not exist in jsdom at all - it
    // is not standard lib.dom.ts either, which is exactly why
    // recordVideo.ts takes a MediaStream rather than calling captureStream
    // itself: the dialog owns that call, so a test can stub it here.
    const fakeStream = { getTracks: () => [] } as unknown as MediaStream;
    const captureStream = vi.fn().mockReturnValue(fakeStream);
    (
      HTMLCanvasElement.prototype as unknown as {
        captureStream: typeof captureStream;
      }
    ).captureStream = captureStream;

    const user = userEvent.setup();
    render(<JourneyDialog open={true} onOpenChange={() => {}} />);

    const recordButton = await screen.findByRole('button', {
      name: /record and download/i,
    });
    // Wait for ENABLED, not merely present. The button is
    // `disabled={status !== 'ready' || recording}`, and findByRole resolves on
    // presence - so clicking the moment it appears races the series promise
    // resolving to 'ready'. A click on a disabled button is a no-op, so
    // recordVideo was never called and the waitFor below timed out: a real
    // ~1-in-8 failure of the suite that gates CI, not a slow machine.
    await waitFor(() => {
      expect(recordButton).toBeEnabled();
    });
    await user.click(recordButton);

    await waitFor(() => {
      expect(recordVideoMock).toHaveBeenCalledTimes(1);
    });
    expect(captureStream).toHaveBeenCalledWith(30);
    expect(recordVideoMock).toHaveBeenCalledWith(
      fakeStream,
      expect.any(Number),
    );
  });

  it('keeps the dialog open and shows the message when the series fails to build', async () => {
    buildJourneySeriesMock.mockReset();
    buildJourneySeriesMock.mockRejectedValue(
      new Error('could not reach the price provider'),
    );

    render(<JourneyDialog open={true} onOpenChange={() => {}} />);

    expect(
      await screen.findByText(/could not reach the price provider/i),
    ).toBeInTheDocument();
    // Still open and usable - a "Try again" affordance, not a closed dialog.
    expect(
      screen.getByRole('button', { name: /try again/i }),
    ).toBeInTheDocument();
    // The record button stays mounted (disabled) rather than the dialog
    // disappearing - closing on failure would lose whatever the owner had
    // set up.
    expect(
      screen.getByRole('button', { name: /record and download/i }),
    ).toBeDisabled();
  });
});
