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
    closePath: record('closePath'),
    // The commit-stream composition paints light with gradients. The stub
    // returns an addColorStop-only object: this file asserts on what TEXT
    // and GEOMETRY were drawn, and a gradient carries neither.
    createLinearGradient: (...args: unknown[]) => {
      calls.push({ method: 'createLinearGradient', args });
      return { addColorStop: () => {} };
    },
    createRadialGradient: (...args: unknown[]) => {
      calls.push({ method: 'createRadialGradient', args });
      return { addColorStop: () => {} };
    },
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
  carriedLabel: 'carried forward',
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
  disposals: [],
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
      disposals: [],
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

describe('the commit-stream composition', () => {
  it('heads the frame with the span the journey covers', () => {
    // The owner asked for the years at the top. Computed from the series
    // rather than passed in: it is digits and a dash, so it needs no
    // translation, and it is what tells you at a glance what you are
    // looking at while the rail is still filling.
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(
      ctx,
      {
        points: [
          { timestamp: Date.UTC(2018, 0, 1), totalValue: '100', holdings: [] },
          { timestamp: Date.UTC(2025, 11, 1), totalValue: '900', holdings: [] },
        ],
        acquisitions: [],
        disposals: [],
      },
      { ...baseParams, mode: 'absolute', progress: 1 },
    );

    expect(fillTexts(calls)).toContain('2018 — 2025');
  });

  it('names a single year without a span', () => {
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(
      ctx,
      {
        points: [
          { timestamp: Date.UTC(2025, 0, 1), totalValue: '100', holdings: [] },
          { timestamp: Date.UTC(2025, 5, 1), totalValue: '200', holdings: [] },
        ],
        acquisitions: [],
        disposals: [],
      },
      { ...baseParams, mode: 'absolute', progress: 1 },
    );

    expect(fillTexts(calls)).toContain('2025');
    expect(fillTexts(calls).join(' ')).not.toContain('2025 — 2025');
  });

  it('hides a DISPOSAL quantity in "relative" mode, exactly as it hides an acquisition', () => {
    // The shrinking half of the scene carries quantities too, and a
    // quantity is an absolute figure whichever direction it moved in. A
    // disposal exempted from the rule would hand back everything the
    // acquisition rule protects.
    const series: JourneySeries = {
      points: fixturePoints,
      acquisitions: [],
      disposals: [
        { timestamp: 1, assetId: 'cardano:lovelace', amount: '0.015' },
      ],
    };

    const absolute = createRecordingContext();
    renderJourneyFrame(absolute.ctx, series, {
      ...baseParams,
      mode: 'absolute',
      progress: 1,
    });
    const relative = createRecordingContext();
    renderJourneyFrame(relative.ctx, series, {
      ...baseParams,
      mode: 'relative',
      progress: 1,
    });

    expect(fillTexts(absolute.calls)).toContain(
      'Bought 0.015 cardano:lovelace',
    );
    for (const text of fillTexts(relative.calls)) {
      expect(text).not.toContain('0.015');
    }
  });

  it('says when the figure it shows was carried rather than priced', () => {
    const carried: JourneySeries = {
      points: [
        { timestamp: 1, totalValue: '20000.00', holdings: [] },
        { timestamp: 2, totalValue: '20000.00', holdings: [], carried: true },
      ],
      acquisitions: [],
      disposals: [],
    };
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(ctx, carried, {
      ...baseParams,
      mode: 'absolute',
      progress: 1,
    });

    // A picture may fill its gaps; it must not pass the filling off as a
    // measurement.
    expect(fillTexts(calls)).toContain('carried forward');
  });

  it('stays silent about carrying when the figure was really priced', () => {
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(ctx, fixtureSeries, {
      ...baseParams,
      mode: 'absolute',
      progress: 1,
    });
    expect(fillTexts(calls)).not.toContain('carried forward');
  });

  it('thins out marker labels instead of overprinting eighty of them', () => {
    // The owner's own wallet produced 80 events. Every node is still drawn;
    // the labels are spaced, first-come-first-served, so the earliest keeps
    // its caption and a dense cluster goes unlabelled rather than
    // illegible.
    const points: SeriesPoint[] = Array.from({ length: 40 }, (_, i) => ({
      timestamp: i + 1,
      totalValue: String((i + 1) * 100),
      holdings: [],
    }));
    const acquisitions = points.map((point) => ({
      timestamp: point.timestamp,
      assetId: 'bitcoin:native',
      amount: '0.01',
    }));

    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(
      ctx,
      { points, acquisitions, disposals: [] },
      { ...baseParams, mode: 'absolute', progress: 1 },
    );

    const captions = fillTexts(calls).filter((text) =>
      text.startsWith('Bought'),
    );
    expect(captions.length).toBeGreaterThan(0);
    expect(captions.length).toBeLessThan(acquisitions.length);
    // Every marker still gets a node, label or not.
    const arcs = calls.filter((call) => call.method === 'arc');
    expect(arcs.length).toBeGreaterThanOrEqual(acquisitions.length);
  });
});

describe('the frame stays inside itself', () => {
  it('draws every mark and caption within the canvas bounds', () => {
    // Canvas silently accepts coordinates off the edge, so a scale mistake
    // shows up as a clipped or missing element in the exported video rather
    // than as an error anywhere. This is the cheapest guard against that.
    const points: SeriesPoint[] = Array.from({ length: 30 }, (_, i) => ({
      timestamp: Date.UTC(2018, i, 1),
      totalValue: String(1000 + i * 2500),
      holdings: [],
    }));
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(
      ctx,
      {
        points,
        acquisitions: [
          {
            timestamp: Date.UTC(2018, 0, 1),
            assetId: 'bitcoin:native',
            amount: '0.5',
          },
          {
            timestamp: Date.UTC(2019, 5, 1),
            assetId: 'bitcoin:native',
            amount: '0.2',
          },
        ],
        disposals: [
          {
            timestamp: Date.UTC(2020, 2, 1),
            assetId: 'bitcoin:native',
            amount: '0.1',
          },
        ],
      },
      { ...baseParams, mode: 'absolute', progress: 1 },
    );

    const xs: number[] = [];
    const ys: number[] = [];
    for (const call of calls) {
      if (['moveTo', 'lineTo'].includes(call.method)) {
        xs.push(Number(call.args[0]));
        ys.push(Number(call.args[1]));
      }
      if (call.method === 'arc' || call.method === 'fillText') {
        xs.push(Number(call.args[call.method === 'arc' ? 0 : 1]));
        ys.push(Number(call.args[call.method === 'arc' ? 1 : 2]));
      }
    }

    expect(xs.length).toBeGreaterThan(30);
    for (const x of xs) {
      expect(Number.isFinite(x)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(baseParams.width);
    }
    for (const y of ys) {
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(baseParams.height);
    }
  });
});
