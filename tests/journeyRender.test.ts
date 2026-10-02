import { describe, it, expect } from 'vitest';
import { renderJourneyFrame, scaleSeries } from '@/journey/render';
import type { JourneyLabels } from '@/journey/render';
import type { JourneySeries, SeriesPoint } from '@/journey/series';

type RecordedCall = { method: string; args: unknown[] };

/**
 * A plain recording stub for the handful of CanvasRenderingContext2D
 * methods render.ts actually calls - no real canvas needed, which is the
 * whole point of render.ts being a pure function over the context: this
 * lets a test assert exactly what was drawn without jsdom's missing 2D
 * canvas support ever entering the picture.
 */
const createRecordingContext = () => {
  const calls: RecordedCall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const ctx = {
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    fillText: record('fillText'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    arc: record('arc'),
    fill: record('fill'),
    set fillStyle(_value: string) {},
    set strokeStyle(_value: string) {},
    set lineWidth(_value: number) {},
    set font(_value: string) {},
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
};

const labels: JourneyLabels = {
  title: 'Your crypto journey',
  acquisitionPrefix: 'Bought',
  noDataLabel: 'Not enough priced history yet',
};

const baseParams = {
  width: 960,
  height: 540,
  currency: 'eur',
  language: 'en',
  labels,
};

/** Three priced points ending on a large, distinctive total - chosen so
 *  its digits never coincidentally appear in a rounded percentage or in
 *  the small acquisition quantity below. */
const fixturePoints: SeriesPoint[] = [
  { timestamp: 1, totalValue: '20000.00', holdings: [] },
  { timestamp: 2, totalValue: '40000.00', holdings: [] },
  { timestamp: 3, totalValue: '87654.32', holdings: [] },
];

const fixtureSeries: JourneySeries = {
  points: fixturePoints,
  acquisitions: [
    { timestamp: 1, assetId: 'cardano:lovelace', amount: '0.015' },
  ],
};

const fillTexts = (calls: RecordedCall[]): string[] =>
  calls
    .filter((call) => call.method === 'fillText')
    .map((call) => String(call.args[0]));

describe('scaleSeries', () => {
  it('passes the absolute total through as a number in "absolute" mode', () => {
    const scaled = scaleSeries(fixturePoints, 'absolute');
    expect(scaled.map((point) => point.value)).toEqual([
      20000, 40000, 87654.32,
    ]);
  });

  it('expresses every point as a percentage of the final priced total in "relative" mode', () => {
    const scaled = scaleSeries(fixturePoints, 'relative');
    expect(scaled[2].value).toBe(100);
    expect(scaled[0].value).toBeCloseTo((20000 / 87654.32) * 100, 5);
    expect(scaled[1].value).toBeCloseTo((40000 / 87654.32) * 100, 5);
  });

  it('normalises against the last PRICED point, not the last point, when the newest point is unpriced', () => {
    const points: SeriesPoint[] = [
      ...fixturePoints,
      { timestamp: 4, totalValue: null, holdings: [] },
    ];
    const scaled = scaleSeries(points, 'relative');
    expect(scaled[2].value).toBe(100);
    expect(scaled[3].value).toBeNull();
  });

  it('leaves a point null rather than dividing by zero when the final total is zero', () => {
    const points: SeriesPoint[] = [
      { timestamp: 1, totalValue: '0', holdings: [] },
    ];
    expect(scaleSeries(points, 'relative')[0].value).toBeNull();
  });
});

describe('renderJourneyFrame', () => {
  it('draws the real base-currency values in "absolute" mode', () => {
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(ctx, fixtureSeries, {
      ...baseParams,
      mode: 'absolute',
      progress: 1,
    });
    const texts = fillTexts(calls);
    expect(texts.some((text) => text.includes('87,654'))).toBe(true);
    expect(texts.some((text) => text.includes('€'))).toBe(true);
  });

  // The one requirement this feature must not get wrong: in 'relative'
  // mode, no absolute currency amount may reach any draw call - not in an
  // axis label, not in a tooltip, not in a legend, not in the title. This
  // is the test that proves it, by inspecting literally every piece of
  // text the frame drew.
  it('never draws an absolute total in "relative" mode', () => {
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(ctx, fixtureSeries, {
      ...baseParams,
      mode: 'relative',
      progress: 1,
    });
    const texts = fillTexts(calls);

    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text).not.toMatch(/87654|87,654|87\.654/);
      expect(text).not.toMatch(/20000|20,000|40000|40,000/);
      expect(text).not.toContain('€');
      expect(text).not.toContain('EUR');
      // The invariant is NO absolute figure, and a crypto quantity is one:
      // prices are public, so a quantity against a percentage yields the
      // absolute total. Acquisition markers are drawn from the same
      // fillText calls, so they are covered by this loop too.
      expect(text).not.toMatch(/0\.015/);
    }
    // And nothing anywhere in relative mode may carry a digit-bearing
    // quantity for the marker's asset.
    const markerTexts = texts.filter((text) =>
      text.includes('cardano:lovelace'),
    );
    expect(markerTexts.length).toBeGreaterThan(0);
    for (const text of markerTexts) {
      expect(text).not.toMatch(/\d/);
    }
    // The leading-edge readout and the top axis label should both show the
    // normalised percentage instead.
    expect(texts.some((text) => text.includes('100%'))).toBe(true);
  });

  it('shows the acquisition quantity in "absolute" mode but never in "relative"', () => {
    // A quantity IS an absolute figure. Crypto prices are public, so
    // "Bought 0.015 cardano:lovelace" drawn at a point the chart labels
    // 23% gives the portfolio's absolute value directly - and it is worse
    // for the only source that exists: Cardano transactions are
    // 'transfer' and excluded from markers, so a Cardano user's markers
    // are exclusively staking rewards, and a member reward is a
    // near-fixed fraction of stake. One marker would reveal total staked
    // ADA to within a few percent. Shareable mode exists to prevent
    // exactly that.
    const relative = createRecordingContext();
    renderJourneyFrame(relative.ctx, fixtureSeries, {
      ...baseParams,
      mode: 'relative',
      progress: 1,
    });
    const absolute = createRecordingContext();
    renderJourneyFrame(absolute.ctx, fixtureSeries, {
      ...baseParams,
      mode: 'absolute',
      progress: 1,
    });

    expect(fillTexts(absolute.calls)).toContain(
      'Bought 0.015 cardano:lovelace',
    );
    // The marker still exists in relative mode - the asset and the point
    // in time are not secret - it just carries no quantity.
    expect(fillTexts(relative.calls)).toContain('Bought cardano:lovelace');
    for (const text of fillTexts(relative.calls)) {
      expect(text).not.toContain('0.015');
    }
  });

  it('reveals only the fraction of the timeline "progress" asks for', () => {
    const full = createRecordingContext();
    renderJourneyFrame(full.ctx, fixtureSeries, {
      ...baseParams,
      mode: 'absolute',
      progress: 1,
    });
    const partial = createRecordingContext();
    renderJourneyFrame(partial.ctx, fixtureSeries, {
      ...baseParams,
      mode: 'absolute',
      progress: 0.1,
    });

    const lineToCount = (calls: RecordedCall[]) =>
      calls.filter((call) => call.method === 'lineTo').length;

    expect(lineToCount(partial.calls)).toBeLessThan(lineToCount(full.calls));
  });

  it('draws only the "no data" label when nothing in the series could be priced', () => {
    const { ctx, calls } = createRecordingContext();
    const series: JourneySeries = {
      points: [
        { timestamp: 1, totalValue: null, holdings: [] },
        { timestamp: 2, totalValue: null, holdings: [] },
      ],
      acquisitions: [],
    };
    renderJourneyFrame(ctx, series, {
      ...baseParams,
      mode: 'relative',
      progress: 1,
    });
    const texts = fillTexts(calls);
    expect(texts).toContain(labels.noDataLabel);
    expect(calls.some((call) => call.method === 'stroke')).toBe(false);
  });
});
