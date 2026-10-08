import { describe, it, expect } from 'vitest';
import { renderJourneyFrame } from '@/journey/render';
import type { JourneyLabels } from '@/journey/render';
import type { JourneySeries, SeriesPoint } from '@/journey/series';

type RecordedCall = { method: string; args: unknown[]; stops?: unknown[] };

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
    arcTo: record('arcTo'),
    stroke: record('stroke'),
    arc: record('arc'),
    fill: record('fill'),
    closePath: record('closePath'),
    clip: record('clip'),
    // save/restore matter to what gets asserted, not just to housekeeping:
    // the lighting is applied inside save/restore pairs, so a stub without
    // them would skip every glow silently.
    save: record('save'),
    restore: record('restore'),
    measureText: (text: string) => ({ width: String(text).length * 7 }),
    createLinearGradient: (...args: unknown[]) => {
      calls.push({ method: 'createLinearGradient', args });
      return { addColorStop: () => {} };
    },
    createRadialGradient: (...args: unknown[]) => {
      const stops: unknown[] = [];
      calls.push({ method: 'createRadialGradient', args, stops });
      return {
        addColorStop: (offset: number, colour: string) => {
          stops.push(colour);
        },
      };
    },
    set fillStyle(_value: string) {},
    set strokeStyle(_value: string) {},
    set lineWidth(_value: number) {},
    set font(_value: string) {},
    set textAlign(_value: string) {},
    set textBaseline(_value: string) {},
    set globalAlpha(value: number) {
      calls.push({ method: 'set globalAlpha', args: [value] });
    },
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
  noDataLabel: 'No transactions to show yet',
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

/** Monthly samples from January 2024 to March 2025: the series' time span
 *  is what the axis and the playhead are drawn against. */
const fixturePoints: SeriesPoint[] = [
  {
    timestamp: Date.UTC(2024, 0, 1),
    holdings: [{ assetId: ADA, amount: '10000000' }],
  },
  {
    timestamp: Date.UTC(2024, 6, 1),
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
    { timestamp: Date.UTC(2024, 0, 1), assetId: ADA, amount: '10000000' },
    { timestamp: Date.UTC(2024, 6, 1), assetId: ADA, amount: '10000000' },
    { timestamp: Date.UTC(2025, 2, 1), assetId: ADA, amount: '20000000' },
  ],
  disposals: [],
  assets: [ADA],
  finalValue: '87654.32',
  prices: { [ADA]: '0.5', [BTC]: '60000' },
};

const fillTexts = (calls: RecordedCall[]): string[] =>
  calls
    .filter((call) => call.method === 'fillText')
    .map((call) => String(call.args[0]));

const arcs = (calls: RecordedCall[]) =>
  calls.filter((call) => call.method === 'arc');

const frameOf = (
  series: JourneySeries,
  mode: 'absolute' | 'relative',
  progress: number,
) => {
  const { ctx, calls } = createRecordingContext();
  renderJourneyFrame(ctx, series, { ...baseParams, mode, progress });
  return calls;
};

describe('renderJourneyFrame: chrome', () => {
  it('heads the frame with the span the journey covers', () => {
    expect(fillTexts(frameOf(fixtureSeries, 'absolute', 1))).toContain(
      '2024 — 2025',
    );
  });

  it('names a single year without a span', () => {
    const single: JourneySeries = {
      ...fixtureSeries,
      points: fixturePoints.slice(0, 2),
    };
    const texts = fillTexts(frameOf(single, 'absolute', 1));
    expect(texts).toContain('2024');
    expect(texts.some((text) => text.includes('—'))).toBe(false);
  });

  it('labels the years along the time axis', () => {
    // The whole point of the timeline is that a viewer can read WHEN. The
    // span runs January 2024 to March 2025, so 2025 starts inside it.
    expect(fillTexts(frameOf(fixtureSeries, 'absolute', 1))).toContain('2025');
  });

  it('labels the months instead when the whole history fits in one year', () => {
    // 15 July to 8 October 2026: no year boundary to mark, so without
    // this the axis would carry a single "2026" and nothing else.
    const short: JourneySeries = {
      ...fixtureSeries,
      points: [
        { timestamp: Date.UTC(2026, 6, 15), holdings: [] },
        { timestamp: Date.UTC(2026, 9, 8), holdings: [] },
      ],
      acquisitions: [
        { timestamp: Date.UTC(2026, 6, 15), assetId: ADA, amount: '1' },
      ],
    };
    const texts = fillTexts(frameOf(short, 'relative', 1));
    expect(texts.some((text) => /^Aug 2026$/.test(text))).toBe(true);
    expect(texts.some((text) => /^Oct 2026$/.test(text))).toBe(true);
  });

  it('shows the month the playhead is passing through', () => {
    // 55% of the way from 1 Jan 2024 to 1 Mar 2025 is late August 2024.
    expect(fillTexts(frameOf(fixtureSeries, 'absolute', 0.55))).toContain(
      'August 2024',
    );
  });

  it('writes the running date in the viewer’s language', () => {
    const { ctx, calls } = createRecordingContext();
    renderJourneyFrame(ctx, fixtureSeries, {
      ...baseParams,
      language: 'de',
      mode: 'absolute',
      progress: 0.55,
    });
    expect(fillTexts(calls)).toContain('August 2024');
    const { ctx: ctx2, calls: calls2 } = createRecordingContext();
    renderJourneyFrame(ctx2, fixtureSeries, {
      ...baseParams,
      language: 'de',
      mode: 'absolute',
      progress: 0.2,
    });
    expect(fillTexts(calls2)).toContain('März 2024');
  });

  it('draws only the "no data" label when there is nothing to draw', () => {
    const empty: JourneySeries = {
      points: [],
      acquisitions: [],
      disposals: [],
      assets: [],
      finalValue: null,
      prices: {},
    };
    const texts = fillTexts(frameOf(empty, 'absolute', 1));
    expect(texts).toContain(labels.noDataLabel);
    expect(texts).not.toContain(labels.title);
  });
});

describe('renderJourneyFrame: the two modes', () => {
  it('draws no fiat at all while the journey is still playing', () => {
    const texts = fillTexts(frameOf(fixtureSeries, 'absolute', 0.5));
    expect(texts.some((text) => text.includes('€'))).toBe(false);
    expect(texts).not.toContain(labels.todayLabel);
  });

  it('shows the closing total once the journey reaches the end', () => {
    const texts = fillTexts(frameOf(fixtureSeries, 'absolute', 1));
    expect(texts.some((text) => text.includes('87,654'))).toBe(true);
    expect(texts).toContain(labels.todayLabel);
  });

  it('never shows the closing total in "relative" mode', () => {
    const texts = fillTexts(frameOf(fixtureSeries, 'relative', 1));
    expect(texts.some((text) => text.includes('87,654'))).toBe(false);
    expect(texts.some((text) => text.includes('€'))).toBe(false);
    expect(texts).not.toContain(labels.todayLabel);
  });

  it('prints the amount held in WHOLE units in "absolute" mode', () => {
    // 40,000,000 lovelace is 40 ADA. The ledger stores base units; a person
    // reads whole ones, and the old journey printed the lovelace figure.
    const texts = fillTexts(frameOf(fixtureSeries, 'absolute', 1));
    expect(texts.some((text) => /\b40\b/.test(text))).toBe(true);
    expect(texts.some((text) => text.includes('40,000,000'))).toBe(false);
  });

  it('prints no quantity anywhere in "relative" mode', () => {
    // The invariant shareable mode promises: nothing on the frame is an
    // absolute figure. Crypto prices are public, so one quantity gives the
    // value away. Years and the asset count are not quantities.
    const texts = fillTexts(frameOf(fixtureSeries, 'relative', 1));
    for (const text of texts) {
      expect(text).not.toMatch(/\b(10|20|40)\b/);
      expect(text).not.toMatch(/\d{2,},\d{3}/);
    }
  });

  it('captions the latest arrival with its amount in "absolute" mode only', () => {
    const texts = fillTexts(frameOf(fixtureSeries, 'absolute', 1));
    expect(texts.some((text) => /^\+\s?20 ADA$/.test(text))).toBe(true);
    const shareable = fillTexts(frameOf(fixtureSeries, 'relative', 1));
    expect(shareable.some((text) => /^\+\s?20 ADA$/.test(text))).toBe(false);
    expect(shareable.some((text) => /^\+\s?ADA$/.test(text))).toBe(true);
  });
});

describe('renderJourneyFrame: assets', () => {
  it('names assets by their symbol, never by their chain-qualified id', () => {
    const texts = fillTexts(frameOf(fixtureSeries, 'absolute', 1));
    expect(texts.some((text) => text.includes('ADA'))).toBe(true);
    expect(texts.some((text) => text.includes('cardano:'))).toBe(false);
  });

  it('decodes a Cardano native asset’s name from its id', () => {
    // cardano:<policy><"NIGHT" in hex>: readable with no registry call.
    const night = `cardano:${'0'.repeat(56)}4e49474854`;
    const series: JourneySeries = {
      ...fixtureSeries,
      acquisitions: [
        { timestamp: Date.UTC(2024, 0, 1), assetId: night, amount: '1' },
      ],
      assets: [night],
    };
    const texts = fillTexts(frameOf(series, 'relative', 1));
    expect(texts.some((text) => text.includes('NIGHT'))).toBe(true);
    expect(texts.some((text) => text.includes('cardano:'))).toBe(false);
  });

  it('lists the leading assets and counts the rest instead of dropping them', () => {
    const assets = Array.from({ length: 12 }, (_, i) => `cardano:${i}`);
    const series: JourneySeries = {
      ...fixtureSeries,
      acquisitions: assets.map((assetId, i) => ({
        timestamp: Date.UTC(2024, 0, 1 + i),
        assetId,
        amount: '1',
      })),
      assets,
    };
    const texts = fillTexts(frameOf(series, 'relative', 1));
    expect(texts).toContain('and 6 more assets');
  });

  it('only lists an asset once its first coin has landed', () => {
    const series: JourneySeries = {
      ...fixtureSeries,
      acquisitions: [
        { timestamp: Date.UTC(2024, 0, 1), assetId: ADA, amount: '1' },
        { timestamp: Date.UTC(2025, 2, 1), assetId: BTC, amount: '1' },
      ],
      assets: [BTC, ADA],
    };
    const early = fillTexts(frameOf(series, 'relative', 0.3));
    expect(early.some((text) => text.includes('ADA'))).toBe(true);
    expect(early.some((text) => text.includes('BTC'))).toBe(false);
    const late = fillTexts(frameOf(series, 'relative', 1));
    expect(late.some((text) => text.includes('BTC'))).toBe(true);
  });
});

describe('renderJourneyFrame: the jar', () => {
  it('drops a coin for every acquisition that has happened so far', () => {
    // Three buys: January 2024, July 2024, March 2025. At 0.6 of the way
    // through, two of them have landed.
    const early = arcs(frameOf(fixtureSeries, 'relative', 0.6)).length;
    const late = arcs(frameOf(fixtureSeries, 'relative', 1)).length;
    // 0.2 rather than 0: at 0 the first coin is still pouring in and the
    // lit spout adds an arc of its own.
    const one = arcs(frameOf(fixtureSeries, 'relative', 0.2)).length;
    expect(late).toBeGreaterThan(early);
    expect(early).toBeGreaterThan(one);
  });

  it('lifts a sold coin out again', () => {
    const series: JourneySeries = {
      ...fixtureSeries,
      acquisitions: [
        { timestamp: Date.UTC(2024, 0, 1), assetId: ADA, amount: '1' },
      ],
      disposals: [
        { timestamp: Date.UTC(2024, 6, 1), assetId: ADA, amount: '1' },
      ],
    };
    const held = arcs(frameOf(series, 'relative', 0.3));
    const gone = arcs(frameOf(series, 'relative', 1));
    expect(gone.length).toBeLessThan(held.length);
  });

  it('marks every buy and every sell on the time axis', () => {
    // Ticks are 1px strokes on the axis. A sell tick is drawn even when the
    // jar had nothing to lift, because the timeline is the record and the
    // jar is the picture.
    const series: JourneySeries = {
      ...fixtureSeries,
      acquisitions: [],
      disposals: [
        { timestamp: Date.UTC(2024, 6, 1), assetId: BTC, amount: '1' },
      ],
    };
    const withSell = frameOf(series, 'relative', 1).filter(
      (call) => call.method === 'stroke',
    ).length;
    const without = frameOf({ ...series, disposals: [] }, 'relative', 1).filter(
      (call) => call.method === 'stroke',
    ).length;
    expect(withSell).toBe(without + 1);
  });

  it('draws every mark and caption within the canvas bounds', () => {
    // Canvas silently accepts coordinates off the edge, so a layout
    // mistake shows up as a clipped element in the exported video rather
    // than as an error anywhere.
    const points: SeriesPoint[] = Array.from({ length: 30 }, (_, i) => ({
      timestamp: Date.UTC(2018, i, 1),
      holdings: [{ assetId: BTC, amount: String(0.1 * (i + 1)) }],
    }));
    const acquisitions = Array.from({ length: 200 }, (_, i) => ({
      timestamp: Date.UTC(2018, 0, 1 + i * 4),
      assetId: i % 3 === 0 ? BTC : ADA,
      amount: '1000000',
    }));
    const series: JourneySeries = {
      points,
      acquisitions,
      disposals: [
        { timestamp: Date.UTC(2020, 2, 1), assetId: BTC, amount: '1' },
      ],
      assets: [BTC, ADA],
      finalValue: '1234.00',
      prices: { [ADA]: '0.5', [BTC]: '60000' },
    };
    for (const progress of [0, 0.01, 0.37, 0.5, 0.99, 1]) {
      const calls = frameOf(series, 'absolute', progress);
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
    }
  });

  it('plays a single-instant history as already complete', () => {
    // One event, so first === last and the time span is zero. Nothing to
    // divide by; every coin is simply in.
    const series: JourneySeries = {
      points: [fixturePoints[0]],
      acquisitions: [fixtureSeries.acquisitions[0]],
      disposals: [],
      assets: [ADA],
      finalValue: null,
      prices: {},
    };
    expect(arcs(frameOf(series, 'relative', 0.5)).length).toBeGreaterThan(0);
  });
});

describe('the frame is actually lit', () => {
  const frame = () => frameOf(fixtureSeries, 'absolute', 1);

  it('composites its glows additively, so overlapping light accumulates', () => {
    const lit = frame().filter(
      (call) =>
        call.method === 'set globalCompositeOperation' &&
        call.args[0] === 'lighter',
    );
    expect(lit.length).toBeGreaterThan(0);
  });

  it('paints the ground as a pool of light, not a flat fill', () => {
    const [first] = frame().filter(
      (call) => call.method === 'createRadialGradient',
    );
    expect(first).toBeDefined();
  });

  it('balances every save with a restore, so state never leaks', () => {
    const calls = frame();
    const saves = calls.filter((call) => call.method === 'save').length;
    const restores = calls.filter((call) => call.method === 'restore').length;
    expect(saves).toBeGreaterThan(0);
    expect(saves).toBe(restores);
  });
});
