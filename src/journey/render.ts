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
  /** Names how many assets did not fit into a lane, with {{count}}. */
  moreAssets: string;
  /** Captions the closing total, e.g. "value today". */
  todayLabel: string;
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

/** One asset's lane: its amount at each sample, and the peak that lane is
 *  drawn against. */
export type Lane = {
  assetId: string;
  /** Amount held at each sample, as a number - the final pixel-coordinate
   *  boundary, on values that were decimal strings everywhere before. */
  amounts: number[];
  peak: number;
  /**
   * The largest amount ever held, in the asset's own units, whatever the
   * mode.
   *
   * A bubble is sized by its event's amount against this, so the size means
   * "how much this moved the position" in both modes. It cannot be taken
   * from `peak`, which is a percentage in 'relative' mode and would make
   * every bubble the same size there. A radius is a RATIO, not a figure, so
   * it carries no more than the lane's own shape already does.
   */
  rawPeak: number;
};

/**
 * Turns the series into one lane per asset.
 *
 * Each lane is scaled against its OWN peak, because that is the only
 * scaling that means anything: a lane drawn against some portfolio-wide
 * maximum would flatten every asset but the largest into a line on the
 * floor. The cost is that two lanes' heights are not comparable to each
 * other, which the unit printed on each lane is there to make obvious.
 *
 * 'relative' mode divides each lane by its own final amount instead, so the
 * shape survives and the quantity does not. That matters more here than it
 * did when the journey drew fiat: the subject of the picture is now the
 * quantity itself, and a quantity is an absolute figure - crypto prices are
 * public, so one real number on a shared frame gives the holding away.
 */
export const buildLanes = (series: JourneySeries, mode: JourneyMode): Lane[] =>
  series.assets.map((assetId) => {
    const amounts = series.points.map((point) => {
      const holding = point.holdings.find((h) => h.assetId === assetId);
      return holding ? Number(holding.amount) : 0;
    });
    const peak = Math.max(...amounts, 0);
    const rawPeak = peak === 0 ? 1 : peak;
    if (mode === 'absolute') {
      return { assetId, amounts, peak: rawPeak, rawPeak };
    }
    const final = amounts[amounts.length - 1] || peak || 1;
    return {
      assetId,
      amounts: amounts.map((amount) => (amount / final) * 100),
      peak: (peak / final) * 100 || 1,
      rawPeak,
    };
  });

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

/** Lanes below this get thin enough to be unreadable; the rest are named
 *  instead of silently dropped. */
const MAX_LANES = 5;

/** Breathing room between one lane's rail and the next lane's ridge. */
const LANE_GAP = 14;

const INFLOW = '53,224,161';
const OUTFLOW = '255,92,122';

/** The span the journey covers, as the heading. Computed from the series
 *  rather than passed in: it is digits and a dash, so it needs no
 *  translation, and it is the one piece of chrome that tells you at a glance
 *  what you are looking at. */
const spanLabel = (points: SeriesPoint[]): string => {
  if (points.length === 0) {
    // Reached before the empty-series return below used to be, which threw
    // on points[0] - caught by the "nothing to draw" test.
    return '';
  }
  const first = new Date(points[0].timestamp).getUTCFullYear();
  const last = new Date(points[points.length - 1].timestamp).getUTCFullYear();
  return first === last ? `${first}` : `${first} — ${last}`;
};

type Glow = { x: number; y: number; r: number; colour: string; alpha: number };

/**
 * A soft disc of light.
 *
 * Two things make this read as light rather than as a flat translucent
 * circle, and the first version of this renderer had neither: a radial
 * gradient falling to fully transparent, and ADDITIVE compositing, so two
 * glows that overlap get brighter instead of just more opaque. Without
 * `lighter` the whole frame looks like coloured paper cut-outs - which is
 * exactly how it looked.
 *
 * Wrapped in save/restore because both the composite mode and the shadow
 * settings leak into every later draw call otherwise.
 */
const drawGlow = (ctx: CanvasRenderingContext2D, spot: Glow): void => {
  if (typeof ctx.createRadialGradient !== 'function') {
    return;
  }
  const layered = typeof ctx.save === 'function';
  if (layered) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
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
  if (layered) {
    ctx.restore();
  }
};

/**
 * Draws one frame of the journey onto `ctx`. Pure except for the side
 * effect of issuing canvas draw calls - no DOM access, no timers, no i18n
 * - so a test can hand it a plain recording stub in place of a real
 * CanvasRenderingContext2D and assert on exactly what was drawn.
 *
 * One lane per asset, stacked on a shared time axis: each lane is a lit rail
 * with that asset's buys and sells landing on it as glowing nodes, and the
 * amount held riding underneath as a luminous ridge. Parallel branches, the
 * way a commit graph draws them.
 *
 * The animation never reads a price. Holdings come out of the ledger, so the
 * whole history plays offline for any year - which is what retired the
 * "Not enough priced history yet" frame that used to open the video. The one
 * fiat figure is the closing total, and it appears only at the end and only
 * in 'absolute' mode.
 */
export const renderJourneyFrame = (
  ctx: CanvasRenderingContext2D,
  series: JourneySeries,
  params: RenderParams,
): void => {
  const { width, height, mode, currency, language, labels } = params;
  const progress = Math.min(1, Math.max(0, params.progress));

  ctx.clearRect(0, 0, width, height);
  // A pool of light rather than a flat ground: it gives the frame a centre
  // and keeps the corners dark enough for the glows to read against.
  if (typeof ctx.createRadialGradient === 'function') {
    const ground = ctx.createRadialGradient(
      width * 0.5,
      height * 0.45,
      0,
      width * 0.5,
      height * 0.45,
      width * 0.75,
    );
    ground.addColorStop(0, '#0c1324');
    ground.addColorStop(1, '#070b14');
    ctx.fillStyle = ground;
  } else {
    ctx.fillStyle = '#070b14';
  }
  ctx.fillRect(0, 0, width, height);

  const plotLeft = PADDING.left;
  const plotRight = width - PADDING.right;

  const span = spanLabel(series.points);
  if (span !== '') {
    ctx.fillStyle = '#e8edf7';
    ctx.font = '800 34px Archivo, sans-serif';
    ctx.fillText(span, plotLeft, 50);
  }
  ctx.fillStyle = '#7b8aa8';
  ctx.font = '13px sans-serif';
  ctx.fillText(labels.title, plotLeft, 74);

  const lanes = buildLanes(series, mode).slice(0, MAX_LANES);
  if (series.points.length === 0 || lanes.length === 0) {
    ctx.fillStyle = '#7b8aa8';
    ctx.font = '14px sans-serif';
    ctx.fillText(labels.noDataLabel, plotLeft, height / 2);
    return;
  }

  const visibleCount = Math.max(1, Math.round(progress * series.points.length));
  const lastIndex = visibleCount - 1;

  const xForIndex = (index: number): number =>
    series.points.length <= 1
      ? plotLeft
      : plotLeft +
        (plotRight - plotLeft) * (index / (series.points.length - 1));

  const top = PADDING.top;
  const available = height - PADDING.bottom - top;
  const laneHeight = available / lanes.length;
  const head = xForIndex(lastIndex);

  lanes.forEach((lane, laneIndex) => {
    const railY = top + laneHeight * (laneIndex + 1) - LANE_GAP;
    const ridgeTop = top + laneHeight * laneIndex + 18;
    const yForAmount = (amount: number): number =>
      railY - (amount / lane.peak) * (railY - ridgeTop);

    // The ridge: this asset's amount over time.
    if (typeof ctx.createLinearGradient === 'function') {
      ctx.beginPath();
      ctx.moveTo(plotLeft, railY);
      for (let i = 0; i <= lastIndex; i += 1) {
        ctx.lineTo(xForIndex(i), yForAmount(lane.amounts[i]));
      }
      ctx.lineTo(head, railY);
      if (typeof ctx.closePath === 'function') {
        ctx.closePath();
      }
      const fill = ctx.createLinearGradient(0, ridgeTop, 0, railY);
      // Neutral, deliberately. When the ridge was inflow-green it swamped
      // the green buy bubbles and the red sells had nothing to read
      // against, so the whole frame said "line chart" in one colour.
      fill.addColorStop(0, `rgba(${INFLOW},0.34)`);
      fill.addColorStop(1, `rgba(${INFLOW},0.02)`);
      ctx.fillStyle = fill;
      ctx.fill();
    }

    ctx.beginPath();
    for (let i = 0; i <= lastIndex; i += 1) {
      const x = xForIndex(i);
      const y = yForAmount(lane.amounts[i]);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    // A lit filament, not a hairline. Making it neutral to "let the bubbles
    // breathe" just produced a pale area chart with nothing glowing in it;
    // the two coexist because the bubbles sit ON the rail with wide halos
    // while this runs above them.
    const bloom = typeof ctx.save === 'function';
    if (bloom) {
      ctx.save();
      ctx.shadowColor = '#35e0a1';
      ctx.shadowBlur = laneHeight * 0.18;
    }
    ctx.strokeStyle = '#8affd4';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    if (bloom) {
      ctx.restore();
    }

    // The rail.
    ctx.beginPath();
    ctx.moveTo(plotLeft, railY);
    ctx.lineTo(plotRight, railY);
    ctx.strokeStyle = '#2b3c5e';
    ctx.lineWidth = 1;
    ctx.stroke();

    // The lane's own name and scale. In relative mode the peak is a
    // percentage of this asset's final amount and carries no quantity.
    ctx.fillStyle = '#7b8aa8';
    ctx.font = '12px sans-serif';
    ctx.fillText(
      mode === 'relative'
        ? lane.assetId
        : `${lane.assetId} · ${formatAmount(String(lane.peak), language)}`,
      plotLeft,
      ridgeTop - 4,
    );

    // This asset's events, on this asset's rail.
    const nodes = [
      ...series.acquisitions
        .filter((marker) => marker.assetId === lane.assetId)
        .map((marker) => ({ marker, kind: 'in' as const })),
      ...series.disposals
        .filter((marker) => marker.assetId === lane.assetId)
        .map((marker) => ({ marker, kind: 'out' as const })),
    ].sort((a, b) => a.marker.timestamp - b.marker.timestamp);

    const visibleUntil = series.points[lastIndex]?.timestamp ?? 0;
    let lastLabelX = Number.NEGATIVE_INFINITY;
    for (const node of nodes) {
      if (node.marker.timestamp > visibleUntil) {
        continue;
      }
      const index = series.points.findIndex(
        (point) => point.timestamp >= node.marker.timestamp,
      );
      if (index === -1 || index > lastIndex) {
        continue;
      }
      const x = xForIndex(index);
      const colour = node.kind === 'in' ? INFLOW : OUTFLOW;

      // Size says how much this event moved the position: the amount
      // against the largest amount ever held in this lane. Square-rooted so
      // a dust buy stays visible and a position-doubling buy does not
      // swallow the lane - the eye reads area, not radius.
      const influence = Math.min(
        1,
        Math.max(0, Number(node.marker.amount) / lane.rawPeak),
      );
      const bubble = laneHeight * (0.1 + 0.52 * Math.sqrt(influence));

      drawGlow(ctx, {
        x,
        y: railY,
        r: bubble,
        colour,
        alpha: 0.3 + 0.35 * Math.sqrt(influence),
      });
      drawGlow(ctx, { x, y: railY, r: bubble * 0.3, colour, alpha: 0.85 });
      ctx.beginPath();
      ctx.arc(x, railY, Math.max(2, bubble * 0.1), 0, Math.PI * 2);
      ctx.fillStyle = node.kind === 'in' ? '#eafff6' : '#ffe6ec';
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(x, railY);
      ctx.lineTo(x, yForAmount(lane.amounts[index]));
      ctx.strokeStyle = `rgba(${colour},0.35)`;
      ctx.lineWidth = 1;
      ctx.stroke();

      if (x - lastLabelX >= LABEL_SPACING) {
        lastLabelX = x;
        ctx.fillStyle = '#e8edf7';
        ctx.font = '11px sans-serif';
        ctx.fillText(
          formatMarker(node.marker, mode, labels.acquisitionPrefix, language),
          x + 8,
          railY - 8,
        );
      }
    }

    // A thin leading edge, not a disc. As a big additive circle on every
    // rail this was the brightest thing on the frame and read as a blob
    // sitting on the floor.
    ctx.beginPath();
    ctx.moveTo(head, railY);
    ctx.lineTo(head, ridgeTop);
    ctx.strokeStyle = 'rgba(232,237,247,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  // Assets beyond the lane cap are named rather than silently dropped.
  const hidden = series.assets.length - lanes.length;
  if (hidden > 0) {
    ctx.fillStyle = '#7b8aa8';
    ctx.font = '12px sans-serif';
    ctx.fillText(
      labels.moreAssets.replace('{{count}}', String(hidden)),
      plotLeft,
      height - 16,
    );
  }

  // The closing figure: today's total, once, at the end. The only fiat on
  // the frame, and absent in shareable mode because it is an absolute one.
  if (progress >= 1 && mode === 'absolute' && series.finalValue !== null) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#e8edf7';
    ctx.font = '700 40px Archivo, sans-serif';
    ctx.fillText(
      formatValue(Number(series.finalValue), mode, currency, language),
      plotRight,
      56,
    );
    ctx.fillStyle = '#7b8aa8';
    ctx.font = '12px sans-serif';
    ctx.fillText(labels.todayLabel, plotRight, 76);
    ctx.textAlign = 'left';
  }
};
