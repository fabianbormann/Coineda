import { addAmounts } from '@/ledger/amount';
import { symbolOf, toWholeUnits } from '@/components/money/asset';
import type { AcquisitionMarker, JourneySeries, SeriesPoint } from './series';
import { colourOf, packJar, LEGEND_SIZE, TAIL_COLOUR } from './layout';
import type { PlacedCoin, Rect } from './layout';

export type JourneyMode = 'absolute' | 'relative';

/**
 * Every piece of chrome text drawn on the frame that is NOT a value this
 * module computes itself. Passed in already translated, so this module
 * never needs i18n to be testable.
 */
export type JourneyLabels = {
  title: string;
  /** Shown instead of the picture when the series has no events at all. */
  noDataLabel: string;
  /** Names how many assets did not fit into the legend, with {{count}}. */
  moreAssets: string;
  /** Captions the closing total, e.g. "value today". */
  todayLabel: string;
};

export type RenderParams = {
  mode: JourneyMode;
  /** 0..1: how far along the timeline the playhead is, for the animated
   *  preview/export. 1 draws the whole history, settled. */
  progress: number;
  width: number;
  height: number;
  /** Read only in 'absolute' mode, for the closing total. */
  currency: string;
  language: string;
  labels: JourneyLabels;
};

/*
 * The frame, at 960x540:
 *
 *   span + title ............................ running month, or the total
 *
 *   [ latest arrival caption ]    legend: swatch  symbol        amount/count
 *   +-----------+                         ...
 *   |           |                         and N more assets
 *   |  o o o o  |
 *   |o o o o o o|
 *   +-----------+
 *   |--|--|--|--|--|--|--|--|--|--|--|--|--|-- time axis, year labels
 *     2021      2022      2023      2024
 *
 * Every box below is in the same 960x540 space; the renderer scales nothing,
 * because the preview canvas and the exported clip are both exactly that.
 */
const MARGIN = 40;
const HEADER_SPAN_Y = 50;
const HEADER_TITLE_Y = 74;
const JAR: Rect = { left: 70, top: 140, width: 330, height: 298 };
const JAR_CORNER = 26;
/** The tap: a pipe in from the left edge, bending down into a spout over
 *  the middle of the mouth. Coins emerge from the spout's lip. */
const TAP_Y = 92;
const SPOUT_X = JAR.left + JAR.width / 2;
const SPOUT_LIP = 118;
const CAPTION_Y = 104;
const LEGEND_LEFT = 470;
const LEGEND_TOP = 150;
const LEGEND_ROW = 36;
const AXIS_Y = 476;
const AXIS_LABEL_Y = 502;
const TICK = 10;

/**
 * Durations, as fractions of the whole span rather than seconds, because
 * this module only knows `progress`. At the dialog's sweep length a fall
 * takes about a third of a second, which is the difference between
 * "dropped in" and "teleported in".
 */
const FALL = 0.03;
/** Settling into a gap takes a little longer than falling from the tap. */
const SLIDE = 1.5;
/** Evaporating takes twice a fall: a wisp needs time to be seen rising. */
const EVAPORATE = 2;
const GLOW = 0.08;
const CAPTION_FADE = 0.14;

const INK = '#e8edf7';
const MUTE = '#7b8aa8';
const INFLOW = '53,224,161';
const OUTFLOW = '255,92,122';
const FONT = "'PT Sans', sans-serif";

const spanLabel = (points: SeriesPoint[]): string => {
  if (points.length === 0) {
    return '';
  }
  const first = new Date(points[0].timestamp).getUTCFullYear();
  const last = new Date(points[points.length - 1].timestamp).getUTCFullYear();
  return first === last ? `${first}` : `${first} — ${last}`;
};

const formatFiat = (
  value: number,
  currency: string,
  language: string,
): string => {
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

/** A base-unit quantity as the whole units a person reads, e.g. 40,000,000
 *  lovelace as "40". Only ever reached in 'absolute' mode. */
const formatQuantity = (
  amount: string,
  assetId: string,
  language: string,
): string => {
  const whole = toWholeUnits(amount, assetId);
  const numeric = Number(whole);
  if (!Number.isFinite(numeric)) {
    return whole;
  }
  const maximumFractionDigits = numeric >= 1000 ? 2 : numeric >= 1 ? 4 : 8;
  try {
    return new Intl.NumberFormat(language, { maximumFractionDigits }).format(
      numeric,
    );
  } catch {
    return whole;
  }
};

const formatMonth = (timestamp: number, language: string): string => {
  try {
    return new Intl.DateTimeFormat(language, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(timestamp);
  } catch {
    return new Date(timestamp).toISOString().slice(0, 7);
  }
};

const formatShortMonth = (timestamp: number, language: string): string => {
  try {
    return new Intl.DateTimeFormat(language, {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(timestamp);
  } catch {
    return new Date(timestamp).toISOString().slice(0, 7);
  }
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

type Glow = { x: number; y: number; r: number; colour: string; alpha: number };

/**
 * A soft disc of light: a radial gradient falling to transparent, composited
 * additively so two overlapping glows get brighter rather than merely more
 * opaque. Wrapped in save/restore because the composite mode would leak into
 * every later draw call otherwise.
 */
const drawGlow = (ctx: CanvasRenderingContext2D, spot: Glow): void => {
  if (
    typeof ctx.createRadialGradient !== 'function' ||
    typeof ctx.save !== 'function'
  ) {
    return;
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
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
  ctx.restore();
};

const hexToRgb = (hex: string): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 255},${(value >> 8) & 255},${value & 255}`;
};

/*
 * The glass: a heavy tumbler, drawn as material rather than as an outline.
 *
 * The first version was a 2px stroke with one flat reflection, which read
 * as a box with rounded corners. What says "glass" is the way light treats
 * it, so that is what is drawn: walls with thickness, brighter at the edges
 * where the eye looks through more of them (the Fresnel effect) and almost
 * clear face-on; a thick base; an elliptical mouth, its back half behind
 * the coins and its front half over them; soft vertical highlights on the
 * front face; and a shadow on the ground beneath. Coins are packed inside
 * JAR exactly as before - the walls are built outward from it.
 */
const WALL = 6;
const BASE = 12;
const MOUTH_RY = 10;
const OUTER_CORNER = JAR_CORNER + WALL;

/** The inner surface: JAR itself, bottom corners rounded, open at the top. */
const traceInner = (ctx: CanvasRenderingContext2D): void => {
  const right = JAR.left + JAR.width;
  const bottom = JAR.top + JAR.height;
  ctx.moveTo(JAR.left, JAR.top);
  ctx.lineTo(JAR.left, bottom - JAR_CORNER);
  ctx.arcTo(JAR.left, bottom, JAR.left + JAR_CORNER, bottom, JAR_CORNER);
  ctx.lineTo(right - JAR_CORNER, bottom);
  ctx.arcTo(right, bottom, right, bottom - JAR_CORNER, JAR_CORNER);
  ctx.lineTo(right, JAR.top);
};

/** The outer surface: a wall's thickness out, and a thick base below. */
const traceOuter = (ctx: CanvasRenderingContext2D): void => {
  const left = JAR.left - WALL;
  const right = JAR.left + JAR.width + WALL;
  const bottom = JAR.top + JAR.height + BASE;
  ctx.moveTo(left, JAR.top);
  ctx.lineTo(left, bottom - OUTER_CORNER);
  ctx.arcTo(left, bottom, left + OUTER_CORNER, bottom, OUTER_CORNER);
  ctx.lineTo(right - OUTER_CORNER, bottom);
  ctx.arcTo(right, bottom, right, bottom - OUTER_CORNER, OUTER_CORNER);
  ctx.lineTo(right, JAR.top);
};

const canShade = (ctx: CanvasRenderingContext2D): boolean =>
  typeof ctx.createLinearGradient === 'function' &&
  typeof ctx.arcTo === 'function';

/** Half of the mouth's ellipse: the far half (`back`) or the near one. */
const traceMouth = (ctx: CanvasRenderingContext2D, back: boolean): void => {
  if (typeof ctx.ellipse !== 'function') {
    ctx.moveTo(JAR.left - WALL, JAR.top);
    ctx.lineTo(JAR.left + JAR.width + WALL, JAR.top);
    return;
  }
  ctx.ellipse(
    JAR.left + JAR.width / 2,
    JAR.top,
    JAR.width / 2 + WALL / 2,
    MOUTH_RY,
    0,
    back ? Math.PI : 0,
    back ? Math.PI * 2 : Math.PI,
  );
};

const drawGlassBack = (ctx: CanvasRenderingContext2D): void => {
  if (!canShade(ctx)) {
    return;
  }
  const centre = JAR.left + JAR.width / 2;
  const groundY = JAR.top + JAR.height + BASE + 4;
  // The shadow it casts, pooled under the base.
  if (typeof ctx.ellipse === 'function') {
    const shadow = ctx.createRadialGradient(
      centre,
      groundY,
      0,
      centre,
      groundY,
      JAR.width / 2 + 30,
    );
    shadow.addColorStop(0, 'rgba(0,0,0,0.55)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.ellipse(centre, groundY, JAR.width / 2 + 30, 9, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // The far wall seen through the near one: a faint, cool body tint,
  // denser towards the sides.
  const body = ctx.createLinearGradient(JAR.left, 0, JAR.left + JAR.width, 0);
  body.addColorStop(0, 'rgba(170,200,255,0.10)');
  body.addColorStop(0.5, 'rgba(170,200,255,0.025)');
  body.addColorStop(1, 'rgba(170,200,255,0.08)');
  ctx.fillStyle = body;
  ctx.beginPath();
  traceInner(ctx);
  ctx.fill();
  // The far lip of the mouth, behind everything inside.
  ctx.beginPath();
  traceMouth(ctx, true);
  ctx.strokeStyle = 'rgba(210,225,255,0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
};

const drawGlassFront = (ctx: CanvasRenderingContext2D): void => {
  if (!canShade(ctx)) {
    ctx.beginPath();
    ctx.moveTo(JAR.left, JAR.top);
    ctx.lineTo(JAR.left, JAR.top + JAR.height);
    ctx.lineTo(JAR.left + JAR.width, JAR.top + JAR.height);
    ctx.lineTo(JAR.left + JAR.width, JAR.top);
    ctx.strokeStyle = 'rgba(190,210,255,0.45)';
    ctx.lineWidth = 2;
    ctx.stroke();
    return;
  }
  const left = JAR.left - WALL;
  const right = JAR.left + JAR.width + WALL;
  const bottom = JAR.top + JAR.height;

  // The walls and the base as one solid: the ring between the two
  // surfaces, filled even-odd. Brightest at the edges, where the line of
  // sight runs through the most glass.
  const wall = ctx.createLinearGradient(left, 0, right, 0);
  wall.addColorStop(0, 'rgba(225,236,255,0.55)');
  wall.addColorStop(0.08, 'rgba(200,218,255,0.22)');
  wall.addColorStop(0.5, 'rgba(200,218,255,0.12)');
  wall.addColorStop(0.92, 'rgba(200,218,255,0.2)');
  wall.addColorStop(1, 'rgba(225,236,255,0.45)');
  ctx.fillStyle = wall;
  ctx.beginPath();
  traceOuter(ctx);
  traceInner(ctx);
  ctx.fill('evenodd');

  // The base is the thickest glass there is: the light it catches runs
  // along its top face as one bright line, fading out towards the curve.
  const caustic = ctx.createLinearGradient(
    JAR.left,
    0,
    JAR.left + JAR.width,
    0,
  );
  caustic.addColorStop(0, 'rgba(240,246,255,0)');
  caustic.addColorStop(0.3, 'rgba(240,246,255,0.55)');
  caustic.addColorStop(0.7, 'rgba(240,246,255,0.35)');
  caustic.addColorStop(1, 'rgba(240,246,255,0)');
  ctx.beginPath();
  ctx.moveTo(JAR.left + JAR_CORNER, bottom + 1.5);
  ctx.lineTo(JAR.left + JAR.width - JAR_CORNER, bottom + 1.5);
  ctx.strokeStyle = caustic;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Both surfaces, hairline: the outer one crisp, the inner one softer.
  ctx.beginPath();
  traceOuter(ctx);
  ctx.strokeStyle = 'rgba(235,242,255,0.6)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  traceInner(ctx);
  ctx.strokeStyle = 'rgba(235,242,255,0.22)';
  ctx.stroke();

  // Highlights on the front face: a broad soft one down the left, a thin
  // sharp one beside it, and a faint one on the right - the window light
  // a real glass carries. Each fades out at both ends, as a reflection
  // on a curved surface does, rather than stopping square.
  const streak = (x: number, width: number, alpha: number, top: number) => {
    const from = JAR.top + top;
    const to = JAR.top + JAR.height - 40;
    const g = ctx.createLinearGradient(0, from, 0, to);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.2, `rgba(255,255,255,${alpha})`);
    g.addColorStop(0.75, `rgba(255,255,255,${alpha * 0.6})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.moveTo(x, from);
    ctx.lineTo(x, to);
    ctx.strokeStyle = g;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  streak(JAR.left + 16, 16, 0.07, 12);
  streak(JAR.left + 16, 5, 0.2, 18);
  streak(JAR.left + 30, 1.5, 0.22, 30);
  streak(JAR.left + JAR.width - 16, 6, 0.09, 26);

  // The near lip, over the coins: thick and bright, as a rim is.
  ctx.beginPath();
  traceMouth(ctx, false);
  ctx.strokeStyle = 'rgba(235,243,255,0.75)';
  ctx.lineWidth = 2.5;
  ctx.stroke();
};

type Movement = { marker: AcquisitionMarker; kind: 'in' | 'out' };

/** A stable pseudo-random in [0, 1) for the k-th wisp of a coin, seeded by
 *  when the coin arrived, so the same sale evaporates the same way in the
 *  preview and the export. */
const wispOf = (coin: PlacedCoin, k: number): number =>
  ((((Math.floor(coin.arrivesAt / 1000) + k * 7919) * 2654435761) >>> 0) %
    1000) /
  1000;

const easeOut = (u: number): number => 1 - (1 - u) ** 2;
const easeInOut = (u: number): number =>
  u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;

/**
 * Where a coin rests at `t`, with the pile's settling animated: when the
 * coin beneath it evaporated less than one SLIDE ago, it is still on its
 * way down from where it was.
 */
const settledY = (coin: PlacedCoin, t: number, unit: number): number => {
  let index = 0;
  for (let i = 0; i < coin.rests.length; i += 1) {
    if (coin.rests[i].from <= t) {
      index = i;
    }
  }
  const rest = coin.rests[index];
  if (index === 0 || unit === 0) {
    return rest.y;
  }
  const u = (t - rest.from) / (unit * SLIDE);
  if (u >= 1) {
    return rest.y;
  }
  const previous = coin.rests[index - 1];
  return previous.y + (rest.y - previous.y) * easeInOut(u);
};

/*
 * The tap: a chrome wall tap - flange, pipe, valve with a lever, and a
 * spout bending down into an aerator - instead of the flat bars it was.
 *
 * Chrome is drawn the way it looks: a cylinder is dark at its edges and
 * bright along one line, so every pipe is stroked several times along the
 * same path, widest and darkest first, then a white specular line nudged
 * up and to the left, towards the light. Stroking a path rather than
 * filling rectangles is what lets the shading follow the elbow round.
 * The lever stands open while coins are pouring and lies closed when not.
 */
const PIPE = 14;
const ELBOW = 14;
const AERATOR_TOP = SPOUT_LIP - 9;
const VALVE_X = SPOUT_X - 40;

const tracePipe = (ctx: CanvasRenderingContext2D, dx: number, dy: number) => {
  ctx.beginPath();
  ctx.moveTo(10 + dx, TAP_Y + dy);
  ctx.lineTo(SPOUT_X - ELBOW + dx, TAP_Y + dy);
  ctx.arcTo(SPOUT_X + dx, TAP_Y + dy, SPOUT_X + dx, TAP_Y + ELBOW + dy, ELBOW);
  ctx.lineTo(SPOUT_X + dx, AERATOR_TOP + 1 + dy);
};

const chromeAcross = (
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): CanvasGradient => {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, '#3a4252');
  g.addColorStop(0.3, '#eef2f9');
  g.addColorStop(0.5, '#aeb8c8');
  g.addColorStop(0.8, '#6b768a');
  g.addColorStop(1, '#2f3644');
  return g;
};

const drawTap = (ctx: CanvasRenderingContext2D, pouring: boolean): void => {
  if (!canShade(ctx)) {
    ctx.fillStyle = '#9aa8c4';
    ctx.fillRect(0, TAP_Y - PIPE / 2, SPOUT_X + PIPE / 2, PIPE);
    ctx.fillRect(SPOUT_X - PIPE / 2, TAP_Y, PIPE, SPOUT_LIP - TAP_Y);
    return;
  }
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';

  // The pipe, as a cylinder: dark rim to bright core, then the glint.
  const layers: [number, string][] = [
    [PIPE, '#2f3644'],
    [PIPE - 3, '#6b768a'],
    [PIPE - 7, '#aeb8c8'],
    [3, '#dfe5ef'],
  ];
  for (const [width, colour] of layers) {
    tracePipe(ctx, 0, 0);
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  tracePipe(ctx, -2, -3);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Where it comes out of the wall.
  ctx.fillStyle = chromeAcross(ctx, 0, TAP_Y - 16, 0, TAP_Y + 16);
  ctx.fillRect(0, TAP_Y - 16, 10, 32);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(10, TAP_Y - 16, 1, 32);

  // The valve body on top of the pipe, and its cap.
  ctx.fillStyle = chromeAcross(ctx, VALVE_X - 8, 0, VALVE_X + 8, 0);
  ctx.fillRect(VALVE_X - 8, TAP_Y - 20, 16, 14);
  ctx.fillStyle = chromeAcross(ctx, VALVE_X - 10, 0, VALVE_X + 10, 0);
  ctx.fillRect(VALVE_X - 10, TAP_Y - 24, 20, 5);

  // The lever, pivoting on the cap: open while pouring.
  const angle = pouring ? -0.62 : -0.12;
  const pivotY = TAP_Y - 24;
  const endX = VALVE_X + Math.cos(angle) * 30;
  const endY = pivotY + Math.sin(angle) * 30;
  ctx.lineCap = 'round';
  for (const [width, colour] of [
    [7, '#2f3644'],
    [4.5, '#aeb8c8'],
    [1.5, '#f4f7fc'],
  ] as [number, string][]) {
    ctx.beginPath();
    ctx.moveTo(VALVE_X, pivotY);
    ctx.lineTo(endX, endY);
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  // The aerator: a short, wider nozzle, dark inside.
  ctx.fillStyle = chromeAcross(ctx, SPOUT_X - 9, 0, SPOUT_X + 9, 0);
  ctx.fillRect(SPOUT_X - 9, AERATOR_TOP, 18, SPOUT_LIP - AERATOR_TOP);
  ctx.fillStyle = '#151a23';
  ctx.fillRect(SPOUT_X - 7, SPOUT_LIP - 2, 14, 2);
  ctx.restore();

  if (pouring) {
    drawGlow(ctx, {
      x: SPOUT_X,
      y: SPOUT_LIP,
      r: 22,
      colour: '200,225,255',
      alpha: 0.45,
    });
  }
};

/**
 * One coin, wherever it is at `t`: in the stream from the tap, resting in
 * the pile, settling into a gap beneath it, or evaporating.
 *
 * Every coin leaves the spout at the same point and holds the line of the
 * stream for the first half of its fall, so a dense run of events reads as
 * one jet being poured rather than a cloud of coins hanging over the jar.
 * `unit` is how many milliseconds one FALL takes, so the same series
 * animates identically whatever its span - and a `unit` of zero (a
 * single-instant history, or the held final frame) means every coin is
 * settled and every sold one is gone.
 */
const drawCoin = (
  ctx: CanvasRenderingContext2D,
  coin: PlacedCoin,
  t: number,
  unit: number,
  colour: string,
  label: string,
): void => {
  const restY = settledY(coin, t, unit);
  // Emerges from INSIDE the spout - its upper half still hidden behind the
  // pipe, which is drawn over it - rather than appearing whole beneath the
  // lip, which looked like a coin arriving at the tap instead of leaving it.
  const spawnY = SPOUT_LIP - coin.radius * 0.4;
  let x = coin.x;
  let y = restY;
  let r = coin.radius;
  let alpha = 1;
  const rgb = hexToRgb(colour);

  const sinceArrival = unit === 0 ? 1 : (t - coin.arrivesAt) / unit;
  if (sinceArrival < 1) {
    // In the stream until just over half way down, then out to its place;
    // accelerating all the way, with one small bounce on landing.
    const wobble = (wispOf(coin, 0) - 0.5) * 3;
    const spread =
      sinceArrival < 0.55 ? 0 : easeOut((sinceArrival - 0.55) / 0.35);
    x = SPOUT_X + wobble + (coin.x - SPOUT_X - wobble) * Math.min(1, spread);
    if (sinceArrival < 0.85) {
      // Out of the spout at speed, then accelerating: a jet, not a drip.
      // Pure ease-in let every coin hang at the lip before it fell, and a
      // stream that bunches at the top reads as one flowing upward.
      const u = sinceArrival / 0.85;
      y = spawnY + (restY - spawnY) * u * (0.45 + 0.55 * u);
    } else {
      y = restY - r * 0.3 * Math.sin((Math.PI * (sinceArrival - 0.85)) / 0.15);
    }
  }

  let evaporating = 0;
  if (coin.leavesAt !== null && t >= coin.leavesAt) {
    evaporating = unit === 0 ? 1 : (t - coin.leavesAt) / (unit * EVAPORATE);
    if (evaporating >= 1) {
      return;
    }
    // The coin itself thins and shrinks where it stands; the gas is drawn
    // after it, rising.
    alpha = (1 - evaporating) ** 2;
    r = coin.radius * (1 - 0.5 * evaporating);
    y = restY - 6 * evaporating;
  }

  const layered = typeof ctx.save === 'function';
  if (layered) {
    ctx.save();
    ctx.globalAlpha = alpha;
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (typeof ctx.createRadialGradient === 'function') {
    const sheen = ctx.createRadialGradient(
      x - r * 0.35,
      y - r * 0.35,
      r * 0.1,
      x,
      y,
      r,
    );
    sheen.addColorStop(0, 'rgba(255,255,255,0.55)');
    sheen.addColorStop(0.25, colour);
    sheen.addColorStop(1, `rgba(${rgb},0.75)`);
    ctx.fillStyle = sheen;
  } else {
    ctx.fillStyle = colour;
  }
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 1;
  ctx.stroke();

  if (r >= 11) {
    ctx.fillStyle = 'rgba(8,12,24,0.85)';
    ctx.font = `700 ${Math.round(r * 0.72)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label.slice(0, 5), x, y + 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  if (layered) {
    ctx.restore();
  }

  if (evaporating > 0) {
    // Six wisps of the coin's own colour, each on its own course: up,
    // swaying, growing and thinning until there is nothing left.
    for (let k = 0; k < 6; k += 1) {
      const seed = wispOf(coin, k + 1);
      const lead = Math.min(1, evaporating * (1.2 + seed * 0.8));
      if (lead >= 1) {
        continue;
      }
      const rise = (80 + 80 * seed) * easeOut(lead);
      const sway = Math.sin(lead * 7 + k) * (4 + 6 * seed);
      drawGlow(ctx, {
        x: coin.x + (seed - 0.5) * 2 * coin.radius + sway,
        y: restY - rise,
        r: (5 + 4 * seed + coin.radius * 0.3) * (1 + 1.5 * lead),
        colour: rgb,
        alpha: 0.85 * (1 - lead),
      });
    }
    return;
  }

  // Freshly landed: a flash of its own colour that fades as it settles.
  // Not on a held frame (unit 0), where every coin counts as just landed
  // and the whole pile would blaze.
  const settled = sinceArrival - 1;
  if (unit > 0 && settled >= 0) {
    const flash = 1 - clamp01(settled / (GLOW / FALL));
    if (flash > 0) {
      drawGlow(ctx, {
        x,
        y,
        r: r * 1.8 + 10,
        colour: rgb,
        alpha: 0.55 * flash,
      });
    }
  }
};

/**
 * Draws one frame of the journey onto `ctx`. Pure except for the side
 * effect of issuing canvas draw calls - no DOM access, no timers, no i18n
 * - so a test can hand it a plain recording stub in place of a real
 * CanvasRenderingContext2D and assert on exactly what was drawn.
 *
 * The playhead moves through calendar time at a constant rate: `progress`
 * 0 is the first event and 1 is now. Every acquisition drops a coin into
 * the jar as the playhead passes it and every disposal lifts one out; the
 * time axis underneath records each of them as a tick, and the legend
 * keeps the running tally. Nothing here reads a price: the one fiat figure
 * is the closing total, drawn at the end and only in 'absolute' mode.
 */
export const renderJourneyFrame = (
  ctx: CanvasRenderingContext2D,
  series: JourneySeries,
  params: RenderParams,
): void => {
  const { width, height, mode, currency, language, labels } = params;
  const progress = clamp01(params.progress);

  ctx.clearRect(0, 0, width, height);
  if (typeof ctx.createRadialGradient === 'function') {
    const ground = ctx.createRadialGradient(
      width * 0.3,
      height * 0.5,
      0,
      width * 0.3,
      height * 0.5,
      width * 0.8,
    );
    ground.addColorStop(0, '#0d1527');
    ground.addColorStop(1, '#070b14');
    ctx.fillStyle = ground;
  } else {
    ctx.fillStyle = '#070b14';
  }
  ctx.fillRect(0, 0, width, height);

  if (series.points.length === 0) {
    ctx.fillStyle = MUTE;
    ctx.font = `15px ${FONT}`;
    ctx.fillText(labels.noDataLabel, MARGIN, height / 2);
    return;
  }

  // --- Time ---------------------------------------------------------
  const first = series.points[0].timestamp;
  const last = series.points[series.points.length - 1].timestamp;
  const span = Math.max(0, last - first);
  const t = span === 0 ? last : first + span * progress;
  // Zero once the playhead reaches the end: the final frame is held, and
  // a held frame with coins still mid-air would never let them land.
  const unit = progress >= 1 ? 0 : span * FALL;
  const axisLeft = MARGIN;
  const axisRight = width - MARGIN;
  const xForTime = (timestamp: number): number =>
    span === 0
      ? axisRight
      : axisLeft + ((timestamp - first) / span) * (axisRight - axisLeft);

  // --- Header -------------------------------------------------------
  ctx.fillStyle = INK;
  ctx.font = `700 34px ${FONT}`;
  ctx.fillText(spanLabel(series.points), MARGIN, HEADER_SPAN_Y);
  ctx.fillStyle = MUTE;
  ctx.font = `14px ${FONT}`;
  ctx.fillText(labels.title, MARGIN, HEADER_TITLE_Y);

  ctx.textAlign = 'right';
  if (progress >= 1 && mode === 'absolute' && series.finalValue !== null) {
    ctx.fillStyle = INK;
    ctx.font = `700 36px ${FONT}`;
    ctx.fillText(
      formatFiat(Number(series.finalValue), currency, language),
      axisRight,
      HEADER_SPAN_Y + 4,
    );
    ctx.fillStyle = MUTE;
    ctx.font = `13px ${FONT}`;
    ctx.fillText(labels.todayLabel, axisRight, HEADER_TITLE_Y);
  } else {
    ctx.fillStyle = INK;
    ctx.font = `600 26px ${FONT}`;
    ctx.fillText(formatMonth(t, language), axisRight, HEADER_SPAN_Y);
  }
  ctx.textAlign = 'left';

  // --- The jar ------------------------------------------------------
  const rank = new Map(series.assets.map((assetId, i) => [assetId, i]));
  const colourFor = (assetId: string): string =>
    colourOf(assetId, rank.get(assetId) ?? Number.MAX_SAFE_INTEGER);
  const layout = packJar(series, JAR);

  const pouring = layout.coins.some(
    (coin) => coin.arrivesAt <= t && t - coin.arrivesAt < unit,
  );
  drawGlassBack(ctx);
  for (const coin of layout.coins) {
    if (coin.arrivesAt > t) {
      break;
    }
    drawCoin(
      ctx,
      coin,
      t,
      unit,
      colourFor(coin.assetId),
      symbolOf(coin.assetId),
    );
  }
  // The tap goes on AFTER the coins so a coin leaving the spout is hidden
  // by the pipe until it is out.
  drawTap(ctx, pouring);
  drawGlassFront(ctx);

  // --- The latest movement, captioned above the mouth ---------------
  const movements: Movement[] = [
    ...series.acquisitions.map((marker): Movement => ({ marker, kind: 'in' })),
    ...series.disposals.map((marker): Movement => ({ marker, kind: 'out' })),
  ]
    .filter((movement) => movement.marker.timestamp <= t)
    .sort((a, b) => a.marker.timestamp - b.marker.timestamp);
  const latest = movements[movements.length - 1];
  if (latest) {
    const age =
      span === 0 ? 0 : (t - latest.marker.timestamp) / (span * CAPTION_FADE);
    const alpha = 1 - clamp01(age);
    if (alpha > 0) {
      const sign = latest.kind === 'in' ? '+' : '−';
      const symbol = symbolOf(latest.marker.assetId);
      const text =
        mode === 'absolute'
          ? `${sign}${formatQuantity(latest.marker.amount, latest.marker.assetId, language)} ${symbol}`
          : `${sign}${symbol}`;
      const rgb = latest.kind === 'in' ? INFLOW : OUTFLOW;
      ctx.fillStyle = `rgba(${rgb},${alpha})`;
      ctx.font = `700 18px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillText(text, JAR.left + JAR.width, CAPTION_Y);
      ctx.textAlign = 'left';
    }
  }

  // --- Legend -------------------------------------------------------
  const seen = new Set<string>();
  const held = new Map<string, string>();
  const count = new Map<string, number>();
  for (const movement of movements) {
    const { assetId, amount } = movement.marker;
    seen.add(assetId);
    const signed = movement.kind === 'in' ? amount : `-${amount}`;
    held.set(assetId, addAmounts(held.get(assetId) ?? '0', signed));
    count.set(
      assetId,
      (count.get(assetId) ?? 0) + (movement.kind === 'in' ? 1 : -1),
    );
  }
  const listed = series.assets
    .slice(0, LEGEND_SIZE)
    .filter((assetId) => seen.has(assetId));
  listed.forEach((assetId, row) => {
    const y = LEGEND_TOP + row * LEGEND_ROW;
    const colour = colourFor(assetId);
    ctx.beginPath();
    ctx.arc(LEGEND_LEFT + 9, y - 5, 8, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.font = `700 17px ${FONT}`;
    ctx.fillText(symbolOf(assetId), LEGEND_LEFT + 28, y);

    ctx.textAlign = 'right';
    ctx.fillStyle = MUTE;
    ctx.font = `15px ${FONT}`;
    const balance = held.get(assetId) ?? '0';
    ctx.fillText(
      mode === 'absolute' && !balance.startsWith('-')
        ? `${formatQuantity(balance, assetId, language)} ${symbolOf(assetId)}`
        : `×${Math.max(0, count.get(assetId) ?? 0)}`,
      axisRight,
      y,
    );
    ctx.textAlign = 'left';
    ctx.beginPath();
    ctx.moveTo(LEGEND_LEFT, y + 11);
    ctx.lineTo(axisRight, y + 11);
    ctx.strokeStyle = 'rgba(123,138,168,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
  });
  const hidden = series.assets
    .slice(LEGEND_SIZE)
    .filter((assetId) => seen.has(assetId)).length;
  if (hidden > 0) {
    ctx.fillStyle = TAIL_COLOUR;
    ctx.font = `14px ${FONT}`;
    ctx.fillText(
      labels.moreAssets.replace('{{count}}', String(hidden)),
      LEGEND_LEFT + 28,
      LEGEND_TOP + listed.length * LEGEND_ROW,
    );
  }

  // --- Time axis ----------------------------------------------------
  ctx.beginPath();
  ctx.moveTo(axisLeft, AXIS_Y);
  ctx.lineTo(axisRight, AXIS_Y);
  ctx.strokeStyle = '#2b3c5e';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = MUTE;
  ctx.font = `13px ${FONT}`;
  const firstYear = new Date(first).getUTCFullYear();
  const lastYear = new Date(last).getUTCFullYear();
  let lastLabelX = Number.NEGATIVE_INFINITY;
  const yearLabel = (text: string, x: number) => {
    if (x - lastLabelX < 44) {
      return;
    }
    lastLabelX = x;
    ctx.fillText(text, x, AXIS_LABEL_Y);
  };
  const tick = (x: number) => {
    ctx.beginPath();
    ctx.moveTo(x, AXIS_Y - 4);
    ctx.lineTo(x, AXIS_Y + 4);
    ctx.strokeStyle = '#3d5078';
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  if (lastYear > firstYear) {
    yearLabel(String(firstYear), axisLeft);
    for (let year = firstYear + 1; year <= lastYear; year += 1) {
      const x = xForTime(Date.UTC(year, 0, 1));
      tick(x);
      yearLabel(String(year), x + 4);
    }
  } else {
    // A history inside one year has no year boundary to mark, so the
    // months carry the axis instead - a first season deserves a scale too.
    const start = new Date(first);
    for (
      let month = start.getUTCMonth() + 1, year = start.getUTCFullYear();
      Date.UTC(year, month, 1) <= last;
      month += 1
    ) {
      const at = Date.UTC(year, month, 1);
      const x = xForTime(at);
      tick(x);
      yearLabel(formatShortMonth(at, language), x + 4);
    }
  }

  // Every buy above the line, every sell below it, revealed as the
  // playhead passes - the timeline is the record, the jar the picture.
  for (const marker of series.acquisitions) {
    if (marker.timestamp > t) {
      continue;
    }
    const x = xForTime(marker.timestamp);
    ctx.beginPath();
    ctx.moveTo(x, AXIS_Y - 1);
    ctx.lineTo(x, AXIS_Y - 1 - TICK);
    ctx.strokeStyle = `rgba(${INFLOW},0.7)`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  for (const marker of series.disposals) {
    if (marker.timestamp > t) {
      continue;
    }
    const x = xForTime(marker.timestamp);
    ctx.beginPath();
    ctx.moveTo(x, AXIS_Y + 1);
    ctx.lineTo(x, AXIS_Y + 1 + TICK);
    ctx.strokeStyle = `rgba(${OUTFLOW},0.8)`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // The playhead: a lit point on the axis, with a short stem.
  const head = xForTime(t);
  ctx.beginPath();
  ctx.moveTo(head, AXIS_Y);
  ctx.lineTo(head, AXIS_Y - TICK - 14);
  ctx.strokeStyle = 'rgba(232,237,247,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();
  drawGlow(ctx, {
    x: head,
    y: AXIS_Y,
    r: 18,
    colour: '232,237,247',
    alpha: 0.5,
  });
  ctx.beginPath();
  ctx.arc(head, AXIS_Y, 3, 0, Math.PI * 2);
  ctx.fillStyle = INK;
  ctx.fill();
};
