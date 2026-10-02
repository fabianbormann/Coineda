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

const PADDING = { top: 56, right: 24, bottom: 36, left: 24 };

/**
 * Draws one frame of the journey onto `ctx`. Pure except for the side
 * effect of issuing canvas draw calls - no DOM access, no timers, no i18n
 * - so a test can hand it a plain recording stub in place of a real
 * CanvasRenderingContext2D and assert on exactly what was drawn.
 */
export const renderJourneyFrame = (
  ctx: CanvasRenderingContext2D,
  series: JourneySeries,
  params: RenderParams,
): void => {
  const { width, height, mode, currency, language, labels } = params;
  const progress = Math.min(1, Math.max(0, params.progress));

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#f5f5f5';
  ctx.font = '600 20px sans-serif';
  ctx.fillText(labels.title, PADDING.left, 32);

  const scaled = scaleSeries(series.points, mode);
  if (scaled.length === 0) {
    ctx.fillStyle = '#9ca3af';
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

  if (definedValues.length === 0) {
    ctx.fillStyle = '#9ca3af';
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

  ctx.fillStyle = '#9ca3af';
  ctx.font = '12px sans-serif';
  ctx.fillText(
    formatValue(maxValue, mode, currency, language),
    plotLeft,
    plotTop - 8,
  );
  ctx.fillText(
    formatValue(minValue, mode, currency, language),
    plotLeft,
    plotBottom + 16,
  );

  ctx.beginPath();
  let started = false;
  visible.forEach((point, index) => {
    if (point.value === null) {
      return;
    }
    const x = xForIndex(index);
    const y = yForValue(point.value);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 3;
  ctx.stroke();

  const visibleUntil = visible[visible.length - 1]?.timestamp ?? 0;
  for (const marker of series.acquisitions) {
    if (marker.timestamp > visibleUntil) {
      continue;
    }
    const index = visible.findIndex(
      (point) => point.timestamp >= marker.timestamp,
    );
    if (index === -1) {
      continue;
    }
    const point = visible[index];
    if (point.value === null) {
      continue;
    }
    const x = xForIndex(index);
    const y = yForValue(point.value);

    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#f59e0b';
    ctx.fill();

    ctx.fillStyle = '#f5f5f5';
    ctx.font = '11px sans-serif';
    ctx.fillText(
      formatMarker(marker, mode, labels.acquisitionPrefix, language),
      x + 6,
      y - 6,
    );
  }

  const last = [...visible].reverse().find((point) => point.value !== null);
  if (last && last.value !== null) {
    const index = visible.indexOf(last);
    const x = xForIndex(index);
    const y = yForValue(last.value);
    ctx.fillStyle = '#f5f5f5';
    ctx.font = '600 16px sans-serif';
    ctx.fillText(formatValue(last.value, mode, currency, language), x, y - 14);
  }
};
