import { describe, it, expect } from 'vitest';
import {
  packJar,
  restingY,
  colourOf,
  MIN_RADIUS,
  MAX_RADIUS,
} from '@/journey/layout';
import type { JourneySeries } from '@/journey/series';

const ADA = 'cardano:lovelace';
const BTC = 'bitcoin:native';

const jar = { left: 100, top: 100, width: 300, height: 300 };

const seriesOf = (
  acquisitions: JourneySeries['acquisitions'],
  disposals: JourneySeries['disposals'] = [],
  prices: JourneySeries['prices'] = {},
): JourneySeries => ({
  points: [],
  acquisitions,
  disposals,
  assets: [...new Set([...acquisitions, ...disposals].map((m) => m.assetId))],
  finalValue: null,
  prices,
});

const buys = (count: number, assetId = ADA, amount = '1000000') =>
  Array.from({ length: count }, (_, i) => ({
    timestamp: Date.UTC(2024, 0, 1 + i),
    assetId,
    amount,
  }));

const END = Number.MAX_SAFE_INTEGER;

const settled = (coin: {
  x: number;
  rests: { from: number; y: number }[];
}) => ({ x: coin.x, y: coin.rests[coin.rests.length - 1].y });

describe('packJar', () => {
  it('places one coin per acquisition, in the order they happened', () => {
    const layout = packJar(seriesOf(buys(3)), jar);
    expect(layout.coins).toHaveLength(3);
    expect(layout.coins.map((coin) => coin.arrivesAt)).toEqual(
      buys(3).map((b) => b.timestamp),
    );
  });

  it('keeps every coin inside the glass', () => {
    const layout = packJar(seriesOf(buys(120)), jar);
    for (const coin of layout.coins) {
      const { x, y } = settled(coin);
      expect(coin.radius).toBeLessThanOrEqual(layout.radius);
      expect(x - coin.radius).toBeGreaterThanOrEqual(jar.left);
      expect(x + coin.radius).toBeLessThanOrEqual(jar.left + jar.width);
      expect(y - coin.radius).toBeGreaterThanOrEqual(jar.top);
      expect(y + coin.radius).toBeLessThanOrEqual(jar.top + jar.height);
    }
  });

  it('never lets two coins overlap, whatever their sizes', () => {
    // A pile with a coin drawn inside another coin reads as a bug, not as
    // a full jar. Every pair must sit at least their two radii apart - and
    // the radii differ, so the pile is not a grid that could be checked by
    // slot.
    const prices = { [ADA]: '0.5', [BTC]: '60000' };
    const acquisitions = Array.from({ length: 80 }, (_, i) => ({
      timestamp: Date.UTC(2024, 0, 1 + i),
      assetId: i % 7 === 0 ? BTC : ADA,
      amount: i % 7 === 0 ? '1000000' : String(1000000 * (1 + (i % 5))),
    }));
    const layout = packJar(seriesOf(acquisitions, [], prices), jar);
    const sizes = new Set(layout.coins.map((coin) => coin.radius));
    expect(sizes.size).toBeGreaterThan(1);
    for (let i = 0; i < layout.coins.length; i += 1) {
      for (let j = i + 1; j < layout.coins.length; j += 1) {
        const a = settled(layout.coins[i]);
        const b = settled(layout.coins[j]);
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(
          layout.coins[i].radius + layout.coins[j].radius - 0.01,
        );
      }
    }
  });

  it('fills the jar from the bottom up', () => {
    // The first coin to land sits on the floor; the last sits on top of
    // something. Canvas y grows downwards, so "lower" is a larger y.
    const layout = packJar(seriesOf(buys(40)), jar);
    const first = layout.coins[0];
    const last = layout.coins[layout.coins.length - 1];
    const bottom = jar.top + jar.height;
    expect(settled(first).y + first.radius).toBeCloseTo(bottom, 6);
    expect(settled(last).y + last.radius).toBeLessThan(bottom);
  });

  it('starts filling at the middle of the floor, not at a wall', () => {
    const layout = packJar(seriesOf(buys(1)), jar);
    const centre = jar.left + jar.width / 2;
    expect(Math.abs(layout.coins[0].x - centre)).toBeLessThanOrEqual(
      layout.radius,
    );
  });

  it('shrinks the coins so a long history still fits, and never below the floor', () => {
    const few = packJar(seriesOf(buys(5)), jar);
    const many = packJar(seriesOf(buys(400)), jar);
    const absurd = packJar(seriesOf(buys(20000)), jar);
    expect(few.radius).toBe(MAX_RADIUS);
    expect(many.radius).toBeLessThan(few.radius);
    expect(many.radius).toBeGreaterThanOrEqual(MIN_RADIUS);
    expect(absurd.radius).toBe(MIN_RADIUS);
  });

  it('evaporates the most recent coin of that asset on a disposal', () => {
    const acquisitions = [
      { timestamp: Date.UTC(2024, 0, 1), assetId: ADA, amount: '1' },
      { timestamp: Date.UTC(2024, 1, 1), assetId: BTC, amount: '1' },
      { timestamp: Date.UTC(2024, 2, 1), assetId: ADA, amount: '1' },
    ];
    const sold = Date.UTC(2024, 5, 1);
    const layout = packJar(
      seriesOf(acquisitions, [{ timestamp: sold, assetId: ADA, amount: '1' }]),
      jar,
    );
    expect(layout.coins.map((coin) => coin.leavesAt)).toEqual([
      null,
      null,
      sold,
    ]);
  });

  it('evaporates as many coins as the sale covers, newest first', () => {
    const buysOfOne = buys(4, ADA, '1');
    const sold = Date.UTC(2024, 5, 1);
    const layout = packJar(
      seriesOf(buysOfOne, [{ timestamp: sold, assetId: ADA, amount: '3' }]),
      jar,
    );
    expect(layout.coins.map((coin) => coin.leavesAt)).toEqual([
      null,
      sold,
      sold,
      sold,
    ]);
  });

  it('lets small sales add up to a coin instead of each taking one', () => {
    // 0.3 then 0.3 of a 1-coin asset: the first sale is well short of a
    // coin and takes nothing; the second brings the total to 0.6, which
    // rounds to one coin, taken at the second sale.
    const firstSale = Date.UTC(2024, 5, 1);
    const secondSale = Date.UTC(2024, 6, 1);
    const layout = packJar(
      seriesOf(buys(2, ADA, '1'), [
        { timestamp: firstSale, assetId: ADA, amount: '0.3' },
        { timestamp: secondSale, assetId: ADA, amount: '0.3' },
      ]),
      jar,
    );
    expect(layout.coins.map((coin) => coin.leavesAt)).toEqual([
      null,
      secondSale,
    ]);
  });

  it('lets the coins stacked above a sold one settle into its place', () => {
    // One column wide, so A, B and C stack on top of each other. Selling B
    // drops C by B's diameter at the moment of the sale; A does not move.
    const narrow = { ...jar, width: MAX_RADIUS * 2 };
    const tA = Date.UTC(2024, 0, 1);
    const tB = Date.UTC(2024, 1, 1);
    const tC = Date.UTC(2024, 2, 1);
    const sold = Date.UTC(2024, 5, 1);
    const layout = packJar(
      seriesOf(
        [
          { timestamp: tA, assetId: ADA, amount: '1' },
          { timestamp: tB, assetId: BTC, amount: '1' },
          { timestamp: tC, assetId: ADA, amount: '1' },
        ],
        [{ timestamp: sold, assetId: BTC, amount: '1' }],
      ),
      narrow,
    );
    const [a, b, c] = layout.coins;
    expect(a.rests).toHaveLength(1);
    expect(b.leavesAt).toBe(sold);
    expect(c.rests).toEqual([
      { from: tC, y: c.rests[0].y },
      { from: sold, y: c.rests[0].y + b.radius * 2 },
    ]);
    expect(restingY(c, sold - 1)).toBe(c.rests[0].y);
    expect(restingY(c, sold)).toBe(b.rests[0].y);
    expect(restingY(c, END)).toBe(b.rests[0].y);
  });

  it('ignores a disposal of an asset that has no coin in the jar', () => {
    // A history that starts mid-way can sell before it ever bought. The
    // tick still belongs on the timeline (render.ts draws it from the
    // series directly); the jar simply has nothing to evaporate.
    const layout = packJar(
      seriesOf(buys(2), [
        { timestamp: Date.UTC(2023, 0, 1), assetId: BTC, amount: '1' },
      ]),
      jar,
    );
    expect(layout.coins.every((coin) => coin.leavesAt === null)).toBe(true);
  });

  it('sizes each coin by what that purchase is worth today', () => {
    // 4 ADA at 0.50 is 2; 1 ADA is 0.50; 0.5 BTC at 60,000 is 30,000. The
    // weight is a ratio to the most valuable purchase, so the Bitcoin buy
    // is the biggest coin and the ADA ones are in proportion to it - the
    // one measure on which a Bitcoin buy and an ADA reward compare at all.
    const layout = packJar(
      seriesOf(
        [
          { timestamp: 1, assetId: ADA, amount: '4000000' },
          { timestamp: 2, assetId: ADA, amount: '1000000' },
          { timestamp: 3, assetId: BTC, amount: '50000000' },
        ],
        [],
        { [ADA]: '0.5', [BTC]: '60000' },
      ),
      jar,
    );
    const weights = layout.coins.map((coin) => coin.weight);
    expect(weights[2]).toBe(1);
    expect(weights[0]).toBeCloseTo(2 / 30000, 9);
    expect(weights[1]).toBeCloseTo(0.5 / 30000, 9);
    expect(layout.coins[2].radius).toBeGreaterThan(layout.coins[0].radius);
    expect(layout.coins[0].radius).toBeGreaterThan(layout.coins[1].radius);
  });

  it('falls back to the amount against the asset’s own largest buy when nothing is priced', () => {
    const layout = packJar(
      seriesOf([
        { timestamp: 1, assetId: ADA, amount: '4000000' },
        { timestamp: 2, assetId: ADA, amount: '1000000' },
        { timestamp: 3, assetId: BTC, amount: '0.5' },
      ]),
      jar,
    );
    expect(layout.coins.map((coin) => coin.weight)).toEqual([1, 0.25, 1]);
  });

  it('is deterministic, so the preview and the export draw the same pile', () => {
    const series = seriesOf(buys(50));
    expect(packJar(series, jar)).toEqual(packJar(series, jar));
  });

  it('returns an empty pile for an empty series', () => {
    expect(packJar(seriesOf([]), jar).coins).toEqual([]);
  });
});

describe('colourOf', () => {
  it('gives a supported chain its own colour whatever its rank', () => {
    expect(colourOf(BTC, 7)).toBe(colourOf(BTC, 0));
    expect(colourOf(BTC, 0)).not.toBe(colourOf(ADA, 0));
  });

  it('gives the leading unknown assets distinct colours and the long tail one shared one', () => {
    const leading = Array.from({ length: 6 }, (_, rank) =>
      colourOf(`cardano:${rank}`, rank),
    );
    expect(new Set(leading).size).toBe(6);
    expect(colourOf('cardano:a', 20)).toBe(colourOf('cardano:b', 30));
  });
});
