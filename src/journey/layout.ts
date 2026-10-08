import { valueOf } from '@/prices/scale';
import type { AcquisitionMarker, JourneySeries } from './series';

/**
 * Where the coins come to rest, and when.
 *
 * The journey pours every acquisition into a glass jar as a coin and lets
 * every disposal evaporate out of it. The ANIMATION is a pure function of
 * progress (see render.ts), which rules out a physics simulation with
 * state between frames: a preview loop and an export must draw the same
 * pile, and a test must be able to ask "where is coin 17 in May 2023"
 * without stepping anything. So the pile is computed once, here, from the
 * series alone, and the renderer only interpolates between what this says.
 *
 * The pile is built on columns, each as wide as the smallest coin, with a
 * bigger coin lying across several. A new coin lands on the lowest place
 * it fits; a coin that evaporates lets whatever stood on it settle down.
 * Columns rather than a hexagonal grid because gravity on a column is a
 * sum of diameters, and impossible to fake on a grid without a real
 * simulation.
 */

export type Rect = { left: number; top: number; width: number; height: number };

/** One place a coin rests, from `from` until the next rest begins. */
export type Rest = { from: number; y: number };

export type PlacedCoin = {
  assetId: string;
  /** The acquisition's amount, in the asset's base unit, as the series
   *  carries it. Displayed only in 'absolute' mode. */
  amount: string;
  arrivesAt: number;
  /** The timestamp of the disposal that evaporates this coin, or null if
   *  it is still in the jar at the end. */
  leavesAt: number | null;
  /** Centre x, fixed for the coin's whole life. */
  x: number;
  radius: number;
  /** 0..1: what this purchase is worth today against the most valuable
   *  single purchase in the whole history. A ratio, never a figure, so it
   *  is safe to draw in 'relative' mode. Falls back to the amount against
   *  the same asset's largest amount when nothing could be priced. */
  weight: number;
  /** Where the coin has rested, in order: first where it landed, then one
   *  entry per time the pile settled beneath it. Never empty. */
  rests: Rest[];
};

export type JarLayout = {
  coins: PlacedCoin[];
  /** The radius of the largest possible coin. Every coin is this or
   *  smaller, and the smallest is SMALLEST of it. */
  radius: number;
};

/** Above this the pile looks like a handful of beach balls. */
export const MAX_RADIUS = 38;
/** Below this a column is a thread and the pile is sand, which still reads
 *  as "a lot" - but a layout must stop shrinking somewhere. */
export const MIN_RADIUS = 3;
/** The smallest coin ever drawn: a staking reward next to a life-savings
 *  buy is tiny, but it is still a coin, not a pixel. */
const MIN_COIN = 2.5;

/** The y a coin rests at when the playhead is at `t`: the latest rest
 *  that has begun. Before it has landed at all, where it will land. */
export const restingY = (coin: PlacedCoin, t: number): number => {
  let y = coin.rests[0].y;
  for (const rest of coin.rests) {
    if (rest.from <= t) {
      y = rest.y;
    }
  }
  return y;
};

type Movement =
  | { kind: 'in'; marker: AcquisitionMarker }
  | { kind: 'out'; marker: AcquisitionMarker };

/** A stable pseudo-random in [-1, 1) from a coin's index, so a coin sits a
 *  little off its column's centre line and the pile looks tipped in rather
 *  than racked. */
const jitterOf = (index: number): number =>
  ((((index + 1) * 2654435761) >>> 0) % 1000) / 500 - 1;

/**
 * Each acquisition's weight: today's value of that purchase against the
 * most valuable one, when the series carries prices; otherwise the amount
 * against the same asset's largest amount, which at least keeps one
 * asset's story in proportion with itself.
 */
const weightsOf = (series: JourneySeries): number[] => {
  const priced = Object.keys(series.prices).length > 0;
  const values = series.acquisitions.map((marker) => {
    const price = series.prices[marker.assetId];
    if (priced && price !== undefined) {
      const value = Number(valueOf(marker.amount, price, marker.assetId));
      return Number.isFinite(value) ? value : 0;
    }
    const amount = Number(marker.amount);
    return Number.isFinite(amount) ? amount : 0;
  });
  if (priced) {
    const max = Math.max(0, ...values);
    return values.map((value) => (max > 0 ? value / max : 1));
  }
  const peak = new Map<string, number>();
  series.acquisitions.forEach((marker, i) => {
    peak.set(
      marker.assetId,
      Math.max(peak.get(marker.assetId) ?? 0, values[i]),
    );
  });
  return series.acquisitions.map((marker, i) => {
    const max = peak.get(marker.assetId) ?? 0;
    return max > 0 ? values[i] / max : 1;
  });
};

/** The smallest coin is this fraction of the scale, and so is a column. */
const SMALLEST = 0.3;

const radiusFor = (scale: number, weight: number): number =>
  Math.max(MIN_COIN, scale * (SMALLEST + (1 - SMALLEST) * Math.sqrt(weight)));

/** A coin in the jar, with the columns it stands on. */
type Standing = {
  coin: PlacedCoin;
  /** First and last column index, inclusive. */
  first: number;
  last: number;
  y: number;
};

/**
 * Plays the whole history into a pile, and says whether any of it grew
 * past the top of the jar.
 *
 * The jar is divided into columns one SMALLEST coin wide. A coin stands on
 * as many adjacent columns as its diameter covers, resting on the highest
 * of them, and raises all of them to its top - the way a big coin lies
 * across the small ones beneath it. When a coin evaporates, everything
 * still in the jar is stood up again in arrival order on the same
 * columns, so whatever rested on it comes down by exactly as much as the
 * support beneath it allows, and nothing moves sideways.
 */
const simulate = (
  movements: Movement[],
  weightOf: Map<AcquisitionMarker, number>,
  jar: Rect,
  scale: number,
): { coins: PlacedCoin[]; overflow: boolean } => {
  const columns = Math.max(1, Math.floor(jar.width / (scale * SMALLEST * 2)));
  const width = jar.width / columns;
  const centre = jar.left + jar.width / 2;
  const bottom = jar.top + jar.height;
  const heights = new Array<number>(columns).fill(0);
  const standing: Standing[] = [];
  const coins: PlacedCoin[] = [];
  /** Per asset: sold amount not yet matched by an evaporated coin. */
  const carry = new Map<string, number>();
  let overflow = false;

  const supportUnder = (first: number, last: number): number => {
    let height = 0;
    for (let c = first; c <= last; c += 1) {
      height = Math.max(height, heights[c]);
    }
    return height;
  };

  const restack = (at: number): void => {
    heights.fill(0);
    for (const stood of standing) {
      const height = supportUnder(stood.first, stood.last);
      const y = bottom - height - stood.coin.radius;
      if (y !== stood.y) {
        stood.y = y;
        stood.coin.rests.push({ from: at, y });
      }
      for (let c = stood.first; c <= stood.last; c += 1) {
        heights[c] = height + stood.coin.radius * 2;
      }
    }
  };

  for (const movement of movements) {
    const { marker } = movement;
    if (movement.kind === 'in') {
      const radius = radiusFor(scale, weightOf.get(marker) ?? 1);
      const span = Math.min(columns, Math.ceil((radius * 2) / width));
      // The lowest place it fits, and of equally low ones the nearest the
      // middle, so the pile mounds up in the centre rather than from one
      // wall.
      let first = 0;
      let height = Number.POSITIVE_INFINITY;
      for (let a = 0; a + span <= columns; a += 1) {
        const candidate = supportUnder(a, a + span - 1);
        const middle = jar.left + (a + span / 2) * width;
        const chosen = jar.left + (first + span / 2) * width;
        if (
          candidate < height ||
          (candidate === height &&
            Math.abs(middle - centre) < Math.abs(chosen - centre))
        ) {
          first = a;
          height = candidate;
        }
      }
      const last = first + span - 1;
      let y = bottom - height - radius;
      if (y - radius < jar.top) {
        overflow = true;
        y = jar.top + radius;
      }
      const middle = jar.left + (first + span / 2) * width;
      const slack = (span * width) / 2 - radius;
      const coin: PlacedCoin = {
        assetId: marker.assetId,
        amount: marker.amount,
        arrivesAt: marker.timestamp,
        leavesAt: null,
        x: middle + jitterOf(coins.length) * slack * 0.9,
        radius,
        weight: weightOf.get(marker) ?? 1,
        rests: [{ from: marker.timestamp, y }],
      };
      for (let c = first; c <= last; c += 1) {
        heights[c] = height + radius * 2;
      }
      standing.push({ coin, first, last, y });
      coins.push(coin);
      continue;
    }

    // As many of that asset's coins as the sale covers evaporate, newest
    // first, and whatever stood on them settles. "Covers" is cumulative:
    // what a sale leaves over, short of half a coin either way, carries
    // into the next one, so a run of small sales eventually takes a coin
    // and one big sale takes several - the jar tracks what was sold to
    // within half a coin, rather than one coin per sale whatever its size.
    const sold = Number(marker.amount);
    let remaining =
      (carry.get(marker.assetId) ?? 0) + (Number.isFinite(sold) ? sold : 0);
    let taken = false;
    for (let i = standing.length - 1; i >= 0 && remaining > 0; i -= 1) {
      const { coin } = standing[i];
      if (coin.assetId !== marker.assetId) {
        continue;
      }
      const amount = Number(coin.amount);
      const worth = Number.isFinite(amount) && amount > 0 ? amount : 0;
      if (remaining < worth * 0.5) {
        break;
      }
      coin.leavesAt = marker.timestamp;
      standing.splice(i, 1);
      remaining -= worth;
      taken = true;
    }
    carry.set(marker.assetId, remaining);
    if (taken) {
      restack(marker.timestamp);
    }
  }

  return { coins, overflow };
};

/**
 * Packs the series into a jar: the largest scale, from MAX_RADIUS down,
 * at which the whole history fits.
 */
export const packJar = (series: JourneySeries, jar: Rect): JarLayout => {
  const movements: Movement[] = [
    ...series.acquisitions.map((marker): Movement => ({ kind: 'in', marker })),
    ...series.disposals.map((marker): Movement => ({ kind: 'out', marker })),
  ].sort((a, b) => {
    if (a.marker.timestamp !== b.marker.timestamp) {
      return a.marker.timestamp - b.marker.timestamp;
    }
    // At the same instant a buy lands before a sell lifts, so a sell can
    // only ever take a coin that is already in the jar.
    return a.kind === b.kind ? 0 : a.kind === 'in' ? -1 : 1;
  });

  const weights = weightsOf(series);
  const weightOf = new Map<AcquisitionMarker, number>(
    series.acquisitions.map((marker, i) => [marker, weights[i]]),
  );

  let radius = MAX_RADIUS;
  let result = simulate(movements, weightOf, jar, radius);
  while (result.overflow && radius > MIN_RADIUS) {
    radius = Math.max(MIN_RADIUS, radius * 0.92);
    result = simulate(movements, weightOf, jar, radius);
  }
  return { coins: result.coins, radius };
};

/** A chain Coineda ships support for keeps its own colour, whatever its
 *  rank: the eye already knows what orange means on a Bitcoin coin. Lifted
 *  from the brand marks but brightened to carry on a dark ground. */
const CHAIN_COLOURS: Record<string, string | undefined> = {
  'bitcoin:native': '#f7931a',
  'eth:native': '#8da2ff',
  'cardano:lovelace': '#3d8bff',
};

/** For everything else, in rank order. Six, because the legend shows that
 *  many and a seventh hue is not one a viewer could tell apart anyway. */
const PALETTE = [
  '#35e0a1',
  '#ff8ac2',
  '#ffd166',
  '#b48bff',
  '#5ce1ff',
  '#ff8a5c',
];

/** The long tail shares one quiet colour: a 30th asset is part of the
 *  pile, not a character in the story. */
export const TAIL_COLOUR = '#6b7690';

/** How many assets get a colour and a line in the legend. */
export const LEGEND_SIZE = PALETTE.length;

export const colourOf = (assetId: string, rank: number): string => {
  const chain = CHAIN_COLOURS[assetId];
  if (chain) {
    return chain;
  }
  return rank < PALETTE.length ? PALETTE[rank] : TAIL_COLOUR;
};
