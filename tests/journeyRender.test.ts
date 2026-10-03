import { describe, it, expect } from 'vitest';
import { renderJourneyFrame, buildLanes } from '@/journey/render';
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
    // save/restore matter to what gets asserted, not just to housekeeping:
    // the lighting is applied inside save/restore pairs, so a stub without
    // them skipped every glow and every shadow silently - which is how a
    // renderer that drew no glow at all passed this whole file.
    save: record('save'),
    restore: record('restore'),
    // The composition paints light with gradients. The stub returns an
    // addColorStop-only object: this file asserts on what TEXT and GEOMETRY
    // were drawn, and a gradient carries neither.
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
    set textAlign(_value: string) {},
    // Recorded, so a test can assert the frame is actually lit.
    set globalCompositeOperation(value: string) {
      calls.push({ method: 'set globalCompositeOperation', args: [value] });
    },
    set shadowBlur(value: number) {
      calls.push({ method: 'set shadowBlur', args: [value] });
    },
    set shadowColor(value: string) {
      calls.push({ method: 'set shadowColor', args: [value] });
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
};

const labels: JourneyLabels = {
  title: 'Your crypto journey',
  acquisitionPrefix: 'Bought',
  noDataLabel: 'Not enough priced history yet',
  moreAssets: 'and {{count}} more assets',
  todayLabel: 'value today',
};

const baseParams = {
  width: 960,
  height: 540,
  currency: 'eur',
  language: 'en',
  labels,
};

const ADA = 'cardano:lovelace';
const BTC = 'bitcoin:native';

/** Three monthly samples of a growing ADA position, in lovelace - the base
 *  unit the ledger stores. */
const fixturePoints: SeriesPoint[] = [
  {
    timestamp: Date.UTC(2024, 0, 1),
    holdings: [{ assetId: ADA, amount: '10000000' }],
  },
  {
    timestamp: Date.UTC(2024, 1, 1),
    holdings: [{ assetId: ADA, amount: '20000000' }],
  },
  {
    timestamp: Date.UTC(2025, 2, 1),
    holdings: [{ assetId: ADA, amount: '40000000' }],
  },
];

const fixtureSeries: JourneySeries = {
  points: fixturePoints,
  acquisitions: [
    { timestamp: Date.UTC(2024, 0, 1), assetId: ADA, amount: '0.015' },
  ],
  disposals: [],
  assets: [ADA],
  finalValue: '87654.32',
};

const fillTexts = (calls: RecordedCall[]): string[] =>
  calls
    .filter((call) => call.method === 'fillText')
    .map((call) => String(call.args[0]));

const lineToCount = (calls: RecordedCall[]): number =>
  calls.filter((call) => call.method === 'lineTo').length;

describe('buildLanes', () => {
  it('gives each asset its own lane, scaled to its own peak', () => {
    // Amounts cannot be summed across assets, so they cannot share a scale
    // either: against one portfolio-wide maximum, every asset but the
    // largest would be a line along the floor.
    const series: JourneySeries = {
      points: [
        {
          timestamp: 1,
          holdings: [
            { assetId: BTC, amount: '0.5' },
            { assetId: ADA, amount: '10000000' },
          ],
        },
      ],
      acquisitions: [],
      disposals: [],
      assets: [BTC, ADA],
      finalValue: null,
    };

    const lanes = buildLanes(series, 'absolute');
    expect(lanes.map((lane) => lane.assetId)).toEqual([BTC, ADA]);
    expect(lanes[0].peak).toBe(0.5);
    expect(lanes[1].peak).toBe(10000000);
  });

  it('reads a missing holding as zero, not as a gap', () => {
    // An asset sold in full still has a lane - that it went to nothing IS
    // the story - and a sample where it is absent means exactly zero held.
    const series: JourneySeries = {
      points: [
        { timestamp: 1, holdings: [{ assetId: ADA, amount: '10000000' }] },
        { timestamp: 2, holdings: [] },
      ],
      acquisitions: [],
      disposals: [],
      assets: [ADA],
      finalValue: null,
    };

    expect(buildLanes(series, 'absolute')[0].amounts).toEqual([10000000, 0]);
  });

  it('expresses each lane as a percentage of its own final amount in "relative" mode', () => {
    // 10m, 20m, 40m lovelace against a final 40m.
    expect(buildLanes(fixtureSeries, 'relative')[0].amounts).toEqual([
      25, 50, 100,
    ]);
  });
});

describe('renderJourneyFrame', () => {
  it('heads the frame with the span the journey covers', () => {
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(ctx, fixtureSeries, {
      ...baseParams,
      mode: 'absolute',
      progress: 1,
    });
    expect(fillTexts(calls)).toContain('2024 — 2025');
  });

  it('names a single year without a span', () => {
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(
      ctx,
      { ...fixtureSeries, points: fixturePoints.slice(0, 2) },
      { ...baseParams, mode: 'absolute', progress: 1 },
    );
    expect(fillTexts(calls)).toContain('2024');
  });

  it('draws no price at all while the journey is still playing', () => {
    // The point of the change: the animation is about amounts, so no fiat
    // figure belongs on any frame before the last one.
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(ctx, fixtureSeries, {
      ...baseParams,
      mode: 'absolute',
      progress: 0.6,
    });
    for (const text of fillTexts(calls)) {
      expect(text).not.toContain('87,654');
      expect(text).not.toContain('value today');
    }
  });

  it('shows the closing total once the journey reaches the end', () => {
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(ctx, fixtureSeries, {
      ...baseParams,
      mode: 'absolute',
      progress: 1,
    });
    expect(fillTexts(calls).join(' ')).toContain('87,654');
    expect(fillTexts(calls)).toContain('value today');
  });

  it('never shows the closing total in "relative" mode', () => {
    // Shareable mode promises no absolute figure on the frame. The closing
    // total is the one fiat number this composition draws, so it is also
    // the one that has to disappear.
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(ctx, fixtureSeries, {
      ...baseParams,
      mode: 'relative',
      progress: 1,
    });
    for (const text of fillTexts(calls)) {
      expect(text).not.toContain('87,654');
      expect(text).not.toContain('87654');
    }
  });

  it('never prints a lane AMOUNT in "relative" mode', () => {
    // This matters more than it did when the journey drew fiat: the subject
    // of the picture is now the quantity itself, and a quantity is an
    // absolute figure, because crypto prices are public.
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(ctx, fixtureSeries, {
      ...baseParams,
      mode: 'relative',
      progress: 1,
    });
    const texts = fillTexts(calls);
    expect(texts).toContain(ADA);
    for (const text of texts) {
      expect(text).not.toContain('40,000,000');
      expect(text).not.toContain('40000000');
    }
  });

  it('prints the lane peak in "absolute" mode, so the scale is readable', () => {
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(ctx, fixtureSeries, {
      ...baseParams,
      mode: 'absolute',
      progress: 1,
    });
    expect(fillTexts(calls).join(' ')).toContain('40,000,000');
  });

  it('shows the acquisition quantity in "absolute" mode but never in "relative"', () => {
    // A quantity IS an absolute figure. Crypto prices are public, so
    // "Bought 0.015 cardano:lovelace" on a frame whose lane is labelled
    // 100% gives the position away - and it is worse for the only source
    // that exists: Cardano transactions are 'transfer' and excluded from
    // markers, so a Cardano user's markers are exclusively staking rewards,
    // and a member reward is a near-fixed fraction of stake. One marker
    // would reveal total staked ADA to within a few percent.
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

    expect(fillTexts(absolute.calls)).toContain(`Bought 0.015 ${ADA}`);
    // The marker still exists in relative mode - the asset and the point in
    // time are not secret - it just carries no quantity.
    expect(fillTexts(relative.calls)).toContain(`Bought ${ADA}`);
    for (const text of fillTexts(relative.calls)) {
      expect(text).not.toContain('0.015');
    }
  });

  it('hides a DISPOSAL quantity in "relative" mode, exactly as it hides an acquisition', () => {
    // The shrinking half carries quantities too, and a quantity is an
    // absolute figure whichever direction it moved in.
    const series: JourneySeries = {
      ...fixtureSeries,
      acquisitions: [],
      disposals: [
        { timestamp: Date.UTC(2024, 0, 1), assetId: ADA, amount: '0.015' },
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

    expect(fillTexts(absolute.calls)).toContain(`Bought 0.015 ${ADA}`);
    for (const text of fillTexts(relative.calls)) {
      expect(text).not.toContain('0.015');
    }
  });

  it('puts each asset event on its own asset lane', () => {
    // A BTC buy must not land on the ADA rail. With one lane per asset the
    // y-coordinate is what says which asset an event belongs to, so getting
    // this wrong is invisible to any count-based assertion. Compared
    // against each other rather than against a guessed midpoint, so the
    // test says "different lanes" and not "a particular padding".
    const series: JourneySeries = {
      points: [
        {
          timestamp: 1,
          holdings: [
            { assetId: BTC, amount: '1' },
            { assetId: ADA, amount: '10000000' },
          ],
        },
        {
          timestamp: 2,
          holdings: [
            { assetId: BTC, amount: '2' },
            { assetId: ADA, amount: '20000000' },
          ],
        },
      ],
      acquisitions: [
        { timestamp: 2, assetId: BTC, amount: '1' },
        { timestamp: 2, assetId: ADA, amount: '10000000' },
      ],
      disposals: [],
      assets: [BTC, ADA],
      finalValue: null,
    };

    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(ctx, series, {
      ...baseParams,
      mode: 'absolute',
      progress: 1,
    });

    // Filtered by radius: the glow discs are drawn with arc() too, so an
    // unfiltered count measures lighting rather than events.
    const nodeYs = calls
      .filter((call) => call.method === 'arc' && Number(call.args[2]) === 4)
      .map((call) => Number(call.args[1]));

    expect(nodeYs).toHaveLength(2);
    // BTC is the first lane, so its node is strictly above ADA's.
    expect(nodeYs[0]).toBeLessThan(nodeYs[1]);
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
      progress: 0.34,
    });
    expect(lineToCount(partial.calls)).toBeLessThan(lineToCount(full.calls));
  });

  it('names the assets that did not fit a lane instead of dropping them', () => {
    const many = Array.from({ length: 8 }, (_, i) => `chain:asset${i}`);
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(
      ctx,
      {
        points: [
          {
            timestamp: 1,
            holdings: many.map((assetId) => ({ assetId, amount: '100' })),
          },
        ],
        acquisitions: [],
        disposals: [],
        assets: many,
        finalValue: null,
      },
      { ...baseParams, mode: 'absolute', progress: 1 },
    );

    // Five lanes fit; the other three are counted on the frame.
    expect(fillTexts(calls)).toContain('and 3 more assets');
  });

  it('draws only the "no data" label when there is nothing to draw', () => {
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(
      ctx,
      {
        points: [],
        acquisitions: [],
        disposals: [],
        assets: [],
        finalValue: null,
      },
      { ...baseParams, mode: 'absolute', progress: 1 },
    );
    expect(fillTexts(calls)).toContain('Not enough priced history yet');
  });

  it('draws every mark and caption within the canvas bounds', () => {
    // Canvas silently accepts coordinates off the edge, so a scale mistake
    // shows up as a clipped or missing element in the exported video rather
    // than as an error anywhere.
    const points: SeriesPoint[] = Array.from({ length: 30 }, (_, i) => ({
      timestamp: Date.UTC(2018, i, 1),
      holdings: [
        { assetId: BTC, amount: String(0.1 * (i + 1)) },
        { assetId: ADA, amount: String(1000000 * (i + 1)) },
      ],
    }));

    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(
      ctx,
      {
        points,
        acquisitions: [
          { timestamp: Date.UTC(2018, 0, 1), assetId: BTC, amount: '0.5' },
          { timestamp: Date.UTC(2019, 5, 1), assetId: ADA, amount: '200' },
        ],
        disposals: [
          { timestamp: Date.UTC(2020, 2, 1), assetId: BTC, amount: '0.1' },
        ],
        assets: [BTC, ADA],
        finalValue: '1234.00',
      },
      { ...baseParams, mode: 'absolute', progress: 1 },
    );

    const xs: number[] = [];
    const ys: number[] = [];
    for (const call of calls) {
      if (call.method === 'moveTo' || call.method === 'lineTo') {
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

describe('the frame is actually lit', () => {
  /**
   * The composition was ported from a prototype but the LIGHTING was not,
   * and nothing here noticed: the recording stub had no save/restore, so
   * every glow and every shadow was skipped and a renderer drawing flat
   * shapes passed the whole file. These are the assertions that would have
   * caught it.
   */
  const frame = () => {
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(ctx, fixtureSeries, {
      ...baseParams,
      mode: 'absolute',
      progress: 1,
    });
    return calls;
  };

  it('composites its glows additively, so overlapping light accumulates', () => {
    // Without `lighter`, two overlapping glows are just more opaque paint
    // and the frame reads as cut-out paper rather than light.
    const modes = frame()
      .filter((call) => call.method === 'set globalCompositeOperation')
      .map((call) => call.args[0]);
    expect(modes.length).toBeGreaterThan(0);
    expect(modes).toContain('lighter');
  });

  it('gives the value filament a shadow of its own hue', () => {
    // A 2px stroke cannot bloom on its own; the shadow is what makes the
    // ridge look like a lit filament.
    const blurs = frame()
      .filter((call) => call.method === 'set shadowBlur')
      .map((call) => Number(call.args[0]));
    expect(blurs.length).toBeGreaterThan(0);
    expect(Math.max(...blurs)).toBeGreaterThan(0);
  });

  it('paints the ground as a pool of light, not a flat fill', () => {
    // Asserted on the background's own GEOMETRY, not on a count. Counting
    // radial gradients could not fail: the glows make plenty of them, so
    // the count stayed above any threshold even with the background flat -
    // which a mutation proved before this was rewritten.
    const grounds = frame().filter(
      (call) =>
        call.method === 'createRadialGradient' &&
        Number(call.args[5]) === baseParams.width * 0.75,
    );
    expect(grounds).toHaveLength(1);
    expect(Number(grounds[0].args[0])).toBe(baseParams.width * 0.5);
    expect(Number(grounds[0].args[1])).toBe(baseParams.height * 0.45);
  });

  it('balances every save with a restore, so lighting never leaks', () => {
    // A composite mode or shadow left set would tint everything drawn
    // afterwards - including the text.
    const calls = frame();
    const saves = calls.filter((call) => call.method === 'save').length;
    const restores = calls.filter((call) => call.method === 'restore').length;
    expect(saves).toBeGreaterThan(0);
    expect(restores).toBe(saves);
  });
});
