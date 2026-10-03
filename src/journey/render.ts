import type { Holding } from '@/ledger/balances';
import type { JourneySeries, SeriesPoint } from './series';

export type JourneyMode = 'absolute' | 'relative';

/**
 * Every piece of chrome text drawn on the frame that is NOT a value this
 * module computes itself. Passed in already translated, so this module
 * never needs i18n to be testable.
 */
export type JourneyLabels = {
  title: string;
  /** Prefixes each acquisition marker, e.g. "Bought". */
  acquisitionPrefix: string;
  /** Shown instead of a chart when nothing in the series could be priced
   *  at all - there is no total to show a percentage of, in either mode. */
  noDataLabel: string;
  /** Marks a figure carried from the nearest priced sample rather than
   *  priced itself. The frame says so rather than passing the fill off as a
   *  measurement. */
  carriedLabel: string;
};

export type RenderParams = {
  mode: JourneyMode;
  /** 0..1: how much of the timeline to reveal, for the animated
   *  preview/export. 1 draws the whole series. */
  progress: number;
  width: number;
  height: number;
  /** Read only in 'absolute' mode - see scaleSeries. */
  currency: string;
  language: string;
  labels: JourneyLabels;
};

type ScaledPoint = {
  timestamp: number;
  value: number | null;
  holdings: Holding[];
};

/**
 * The ONLY place this module reads an absolute total out of the series.
 *
 * In 'absolute' mode it converts the decimal-string total to a number -
 * the final pixel-coordinate boundary, fine here and nowhere earlier. In
 * 'relative' mode it converts every point to a PERCENTAGE of the final
 * priced total and then discards the absolute number: nothing downstream
 * of this function ever sees `point.totalValue` again, only the resulting
 * `value`, a plain ratio with no currency meaning. That is what makes "no
 * absolute figure in relative mode" structural rather than something every
 * draw call below has to remember to avoid - there is exactly one place an
 * absolute number could leak from, and it is this function.
 */
export const scaleSeries = (
  points: SeriesPoint[],
  mode: JourneyMode,
): ScaledPoint[] => {
  if (mode === 'absolute') {
    return points.map((point) => ({
      timestamp: point.timestamp,
      value: point.totalValue === null ? null : Number(point.totalValue),
      holdings: point.holdings,
    }));
  }

  const finalPriced = [...points]
    .reverse()
    .find((point) => point.totalValue !== null);
  const finalTotal = finalPriced ? Number(finalPriced.totalValue) : null;

  return points.map((point) => {
    if (point.totalValue === null || finalTotal === null || finalTotal === 0) {
      return {
        timestamp: point.timestamp,
        value: null,
        holdings: point.holdings,
      };
    }
    return {
      timestamp: point.timestamp,
      value: (Number(point.totalValue) / finalTotal) * 100,
      holdings: point.holdings,
    };
  });
};

/** Mode-aware value formatting. 'relative' never touches `currency` -
 *  it formats a plain ratio, already stripped of any absolute meaning by
 *  scaleSeries, as a percentage. */
const formatValue = (
  value: number,
  mode: JourneyMode,
  currency: string,
  language: string,
): string => {
  if (mode === 'relative') {
    return `${Math.round(value)}%`;
  }
  try {
    return new Intl.NumberFormat(language, {
      style: 'currency',
      currency: currency.toUpperCase(),
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${Math.round(value)} ${currency.toUpperCase()}`;
  }
};

/**
 * One acquisition marker's label.
 *
 * In 'absolute' mode it names the quantity; in 'relative' mode it names
 * the asset and nothing more. A quantity is NOT safe to share just because
 * it is not denominated in fiat: crypto prices are public, so a quantity
 * drawn against a point the chart labels 23% yields the portfolio's
 * absolute value directly. It is worse for the only source that exists -
 * Cardano transfers are excluded from markers, so a Cardano user's markers
 * are exclusively staking rewards, and a member reward is a near-fixed
 * fraction of stake, which makes one marker enough to recover total staked
 * ADA to within a few percent.
 *
 * The invariant this mode promises is "no absolute figure", and the
 * quantity is one. The asset and the point in time are not, so the marker
 * itself survives.
 */
const formatMarker = (
  marker: { assetId: string; amount: string },
  mode: JourneyMode,
  prefix: string,
  language: string,
): string =>
  mode === 'relative'
    ? `${prefix} ${marker.assetId}`
    : `${prefix} ${formatAmount(marker.amount, language)} ${marker.assetId}`;

/** A crypto quantity. Number(amount) is this module's other final
 *  pixel-coordinate/display boundary, on a value that was always a
 *  decimal string up to this point. Only ever reached in 'absolute' mode -
 *  see formatMarker. */
const formatAmount = (amount: string, language: string): string => {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) {
    return amount;
  }
  try {
    return new Intl.NumberFormat(language, {
      maximumFractionDigits: 8,
    }).format(numeric);
  } catch {
    return amount;
  }
};

const PADDING = { top: 96, right: 40, bottom: 64, left: 40 };

/** Minimum horizontal gap between two marker labels. Labels are assigned
 *  first-come-first-served down the timeline, so an early marker keeps its
 *  label and a cluster of later ones goes unlabelled rather than eighty
 *  captions overprinting each other. The nodes themselves are always drawn. */
const LABEL_SPACING = 130;

const INFLOW = '53,224,161';
const OUTFLOW = '255,92,122';

/** The span the journey covers, as the heading. Computed from the series
 *  rather than passed in: it is digits and a dash, so it needs no
 *  translation, and it is the one piece of chrome that tells you at a glance
 *  what you are looking at. */
const spanLabel = (points: ScaledPoint[]): string => {
  const first = new Date(points[0].timestamp).getUTCFullYear();
  const last = new Date(points[points.length - 1].timestamp).getUTCFullYear();
  return first === last ? `${first}` : `${first} — ${last}`;
};

type Glow = { x: number; y: number; r: number; colour: string; alpha: number };

/** A soft disc, drawn as a radial gradient so it reads as light rather than
 *  as a flat circle. Guarded because the recording stub a test passes in
 *  implements only the handful of methods this module needs. */
const drawGlow = (ctx: CanvasRenderingContext2D, spot: Glow): void => {
  if (typeof ctx.createRadialGradient !== 'function') {
    return;
  }
  const gradient = ctx.createRadialGradient(
    spot.x,
    spot.y,
    0,
    spot.x,
    spot.y,
    spot.r,
  );
  gradient.addColorStop(0, `rgba(${spot.colour},${spot.alpha})`);
  gradient.addColorStop(1, `rgba(${spot.colour},0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(spot.x, spot.y, spot.r, 0, Math.PI * 2);
  ctx.fill();
};

/**
 * Draws one frame of the journey onto `ctx`. Pure except for the side
 * effect of issuing canvas draw calls - no DOM access, no timers, no i18n
 * - so a test can hand it a plain recording stub in place of a real
 * CanvasRenderingContext2D and assert on exactly what was drawn.
 *
 * The composition is a lit rail: time runs along it, every acquisition and
 * disposal lands on it as a glowing node sized by its own amount, and the
 * portfolio value rides underneath as a luminous ridge. It replaced a plain
 * polyline that grew from zero width, which left the opening seconds of a
 * recorded video nearly empty - the thing a viewer sees first.
 */
export const renderJourneyFrame = (
  ctx: CanvasRenderingContext2D,
  series: JourneySeries,
  params: RenderParams,
): void => {
  const { width, height, mode, currency, language, labels } = params;
  const progress = Math.min(1, Math.max(0, params.progress));

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#070b14';
  ctx.fillRect(0, 0, width, height);

  const scaled = scaleSeries(series.points, mode);
  if (scaled.length === 0) {
    ctx.fillStyle = '#e8edf7';
    ctx.font = '800 32px Archivo, sans-serif';
    ctx.fillText(labels.title, PADDING.left, 56);
    ctx.fillStyle = '#7b8aa8';
    ctx.font = '14px sans-serif';
    ctx.fillText(labels.noDataLabel, PADDING.left, height / 2);
    return;
  }

  const visibleCount = Math.max(1, Math.round(progress * scaled.length));
  const visible = scaled.slice(0, visibleCount);

  const plotLeft = PADDING.left;
  const plotRight = width - PADDING.right;
  const plotTop = PADDING.top;
  const plotBottom = height - PADDING.bottom;

  const definedValues = visible
    .map((point) => point.value)
    .filter((value): value is number => value !== null);

  // The heading goes on before the early return: a frame with nothing
  // priced yet should still say what it is, not read as a broken render.
  ctx.fillStyle = '#e8edf7';
  ctx.font = '800 34px Archivo, sans-serif';
  ctx.fillText(spanLabel(scaled), plotLeft, 50);
  ctx.fillStyle = '#7b8aa8';
  ctx.font = '13px sans-serif';
  ctx.fillText(labels.title, plotLeft, 74);

  if (definedValues.length === 0) {
    ctx.fillStyle = '#7b8aa8';
    ctx.font = '14px sans-serif';
    ctx.fillText(labels.noDataLabel, plotLeft, (plotTop + plotBottom) / 2);
    return;
  }

  const maxValue = Math.max(...definedValues, 0);
  const minValue = Math.min(0, ...definedValues);
  const valueRange = maxValue - minValue === 0 ? 1 : maxValue - minValue;

  const xForIndex = (index: number): number =>
    scaled.length <= 1
      ? plotLeft
      : plotLeft + (plotRight - plotLeft) * (index / (scaled.length - 1));

  const yForValue = (value: number): number =>
    plotBottom - ((value - minValue) / valueRange) * (plotBottom - plotTop);

  const railY = plotBottom;
  const head = xForIndex(Math.max(0, visible.length - 1));

  // The ridge: value as a filled, glowing area under the rail.
  const ridge = visible
    .map((point, index) => ({ point, index }))
    .filter((entry) => entry.point.value !== null);

  if (typeof ctx.createLinearGradient === 'function') {
    ctx.beginPath();
    ctx.moveTo(xForIndex(ridge[0].index), railY);
    for (const entry of ridge) {
      ctx.lineTo(
        xForIndex(entry.index),
        yForValue(entry.point.value as number),
      );
    }
    ctx.lineTo(xForIndex(ridge[ridge.length - 1].index), railY);
    if (typeof ctx.closePath === 'function') {
      ctx.closePath();
    }
    const fill = ctx.createLinearGradient(0, plotTop, 0, railY);
    fill.addColorStop(0, `rgba(${INFLOW},0.42)`);
    fill.addColorStop(1, `rgba(${INFLOW},0.02)`);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  ctx.beginPath();
  let started = false;
  for (const entry of ridge) {
    const x = xForIndex(entry.index);
    const y = yForValue(entry.point.value as number);
    if (started) {
      ctx.lineTo(x, y);
    } else {
      ctx.moveTo(x, y);
      started = true;
    }
  }
  ctx.strokeStyle = '#8affd4';
  ctx.lineWidth = 3;
  ctx.stroke();

  // The rail itself.
  ctx.beginPath();
  ctx.moveTo(plotLeft, railY);
  ctx.lineTo(plotRight, railY);
  ctx.strokeStyle = '#1b2740';
  ctx.lineWidth = 1;
  ctx.stroke();

  // The axis labels stay where they were: the extremes of what is drawn,
  // formatted by mode, so relative mode still never names a total.
  ctx.fillStyle = '#7b8aa8';
  ctx.font = '12px sans-serif';
  ctx.fillText(
    formatValue(maxValue, mode, currency, language),
    plotLeft,
    plotTop - 8,
  );
  ctx.fillText(
    formatValue(minValue, mode, currency, language),
    plotLeft,
    railY + 20,
  );

  const visibleUntil = visible[visible.length - 1]?.timestamp ?? 0;
  const nodes = [
    ...series.acquisitions.map((marker) => ({ marker, kind: 'in' as const })),
    ...series.disposals.map((marker) => ({ marker, kind: 'out' as const })),
  ]
    .filter((node) => node.marker.timestamp <= visibleUntil)
    .sort((a, b) => a.marker.timestamp - b.marker.timestamp);

  let lastLabelX = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const index = visible.findIndex(
      (point) => point.timestamp >= node.marker.timestamp,
    );
    if (index === -1) {
      continue;
    }
    const x = xForIndex(index);
    const colour = node.kind === 'in' ? INFLOW : OUTFLOW;

    drawGlow(ctx, { x, y: railY, r: 34, colour, alpha: 0.55 });
    ctx.beginPath();
    ctx.arc(x, railY, 5, 0, Math.PI * 2);
    ctx.fillStyle = node.kind === 'in' ? '#c9ffe9' : '#ffd0da';
    ctx.fill();

    // A stem up to the ridge, so a node reads as attached to the value it
    // moved rather than floating on the axis.
    const point = visible[index];
    if (point.value !== null) {
      ctx.beginPath();
      ctx.moveTo(x, railY);
      ctx.lineTo(x, yForValue(point.value));
      ctx.strokeStyle = `rgba(${colour},0.35)`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (x - lastLabelX >= LABEL_SPACING) {
      lastLabelX = x;
      ctx.fillStyle = '#e8edf7';
      ctx.font = '11px sans-serif';
      ctx.fillText(
        formatMarker(node.marker, mode, labels.acquisitionPrefix, language),
        x + 8,
        railY - 10,
      );
    }
  }

  // The playhead, and the running total beside it.
  drawGlow(ctx, {
    x: head,
    y: railY,
    r: 70,
    colour: '232,237,247',
    alpha: 0.42,
  });

  const last = [...visible].reverse().find((point) => point.value !== null);
  if (last && last.value !== null) {
    const index = visible.indexOf(last);
    const x = xForIndex(index);
    const y = yForValue(last.value);
    ctx.fillStyle = '#e8edf7';
    ctx.font = '600 28px Archivo, sans-serif';
    ctx.fillText(formatValue(last.value, mode, currency, language), x, y - 18);

    // Says so when the figure was carried rather than priced. A picture may
    // fill its gaps; it should not pass the filling off as a measurement.
    const sourcePoint = series.points[index];
    if (sourcePoint?.carried) {
      ctx.fillStyle = '#f7a23b';
      ctx.font = '11px sans-serif';
      ctx.fillText(labels.carriedLabel, x, y + 4);
    }
  }
};
