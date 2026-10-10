// The contrast maths, in plain JavaScript so that both the typed wrapper
// (src/a11y/contrast.ts, used by the test) and the Node script
// (scripts/contrast.mjs, which prints the table for docs/accessibility.md)
// run the SAME code. Node 22 cannot import TypeScript without a flag, and a
// duplicated copy of the maths would be a second thing to keep honest.
//
// Pure: no DOM, no filesystem, no dependencies. Colours are { r, g, b, a }
// with r/g/b in 0..255 (not rounded) and a in 0..1.

/** @typedef {{ r: number, g: number, b: number, a: number }} Rgba */
/** @typedef {'light' | 'dark'} Theme */

/** @param {number} v */
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * A number, a percentage (of `percentOf`), or `none` (CSS Color 4).
 * @param {string} token
 */
const num = (token, percentOf = 1) => {
  const t = token.trim();
  if (t === 'none') return 0;
  if (t.endsWith('%')) return (parseFloat(t) / 100) * percentOf;
  const v = parseFloat(t);
  if (Number.isNaN(v)) throw new Error(`Not a number: ${token}`);
  return v;
};

/**
 * Hue in degrees, accepting deg/turn/rad/grad units.
 * @param {string} token
 */
const hue = (token) => {
  const t = token.trim();
  if (t === 'none') return 0;
  if (t.endsWith('turn')) return parseFloat(t) * 360;
  if (t.endsWith('grad')) return parseFloat(t) * 0.9;
  if (t.endsWith('rad')) return (parseFloat(t) * 180) / Math.PI;
  return parseFloat(t);
};

/**
 * Splits `a b c / d` or `a, b, c, d` into [channels, alpha].
 * @param {string} inner
 * @returns {[string[], string | undefined]}
 */
const args = (inner) => {
  const [main, alpha] = inner.split('/');
  const parts = main
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (alpha === undefined && parts.length === 4) {
    return [parts.slice(0, 3), parts[3]];
  }
  return [parts, alpha === undefined ? undefined : alpha.trim()];
};

/** @param {number} linear */
const encode = (linear) => {
  const v = clamp01(linear);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};

/** @param {number} channel */
const decode = (channel) => {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/**
 * OKLCH -> OKLab -> linear sRGB -> sRGB (Bjorn Ottosson's matrices, which
 * CSS Color 4 uses). Out-of-gamut results are clipped per channel to [0, 1],
 * which is what browsers paint on an sRGB display.
 * @param {number} L
 * @param {number} C
 * @param {number} H
 * @returns {Rgba}
 */
export function oklchToRgb(L, C, H, alpha = 1) {
  const hr = (H * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return {
    r: encode(r) * 255,
    g: encode(g) * 255,
    b: encode(bl) * 255,
    a: clamp01(alpha),
  };
}

/**
 * @param {number} h degrees
 * @param {number} s 0..1
 * @param {number} l 0..1
 * @param {number} alpha
 * @returns {Rgba}
 */
const hslToRgb = (h, s, l, alpha) => {
  /** @param {number} n */
  const k = (n) => (n + h / 30) % 12;
  /** @param {number} n */
  const f = (n) =>
    l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255, a: clamp01(alpha) };
};

/** @type {Record<string, Rgba>} */
const NAMED = {
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

/**
 * Parses a single CSS colour: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba()
 * (comma or space syntax, optional `/ alpha`), hsl()/hsla(), oklch() and the
 * keywords white/black/transparent.
 * @param {string} text
 * @returns {Rgba}
 */
export function parseCssColor(text) {
  const t = text.trim().toLowerCase();
  if (t in NAMED) return { ...NAMED[t] };

  if (t.startsWith('#')) {
    let hex = t.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = [...hex].map((c) => c + c).join('');
    }
    if (!/^[0-9a-f]+$/.test(hex) || (hex.length !== 6 && hex.length !== 8)) {
      throw new Error(`Bad hex colour: ${text}`);
    }
    /** @param {number} i */
    const at = (i) => parseInt(hex.slice(i, i + 2), 16);
    return {
      r: at(0),
      g: at(2),
      b: at(4),
      a: hex.length === 8 ? at(6) / 255 : 1,
    };
  }

  const fn = /^([a-z]+)\(([\s\S]*)\)$/.exec(t);
  if (!fn) throw new Error(`Unsupported colour: ${text}`);
  const [, name, inner] = fn;
  const [ch, alphaToken] = args(inner);
  const alpha = alphaToken === undefined ? 1 : num(alphaToken);
  if (ch.length !== 3) throw new Error(`Expected 3 channels: ${text}`);

  switch (name) {
    case 'rgb':
    case 'rgba':
      return {
        r: num(ch[0], 255),
        g: num(ch[1], 255),
        b: num(ch[2], 255),
        a: clamp01(alpha),
      };
    case 'hsl':
    case 'hsla': {
      /** @param {string} p */
      const pct = (p) => clamp01(p.endsWith('%') ? num(p) : num(p) / 100);
      return hslToRgb(
        ((hue(ch[0]) % 360) + 360) % 360,
        pct(ch[1]),
        pct(ch[2]),
        alpha,
      );
    }
    case 'oklch':
      return oklchToRgb(num(ch[0]), num(ch[1], 0.4), hue(ch[2]), alpha);
    default:
      throw new Error(`Unsupported colour function: ${name}`);
  }
}

/**
 * Paints `fg` (possibly translucent) over `bg` and returns the opaque result.
 * `bg` must be opaque - composite it over the page first if it is not.
 * @param {Rgba} fg
 * @param {Rgba} bg
 * @returns {Rgba}
 */
export function composite(fg, bg) {
  if (bg.a < 1) throw new Error('composite() needs an opaque background');
  /** @param {number} f @param {number} b */
  const mix = (f, b) => f * fg.a + b * (1 - fg.a);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

/**
 * WCAG 2.x relative luminance of an opaque sRGB colour.
 * @param {{ r: number, g: number, b: number }} c
 * @returns {number}
 */
export function relativeLuminance(c) {
  return 0.2126 * decode(c.r) + 0.7152 * decode(c.g) + 0.0722 * decode(c.b);
}

/**
 * WCAG 2.x contrast ratio, 1..21, of two opaque colours.
 * @param {{ r: number, g: number, b: number }} a
 * @param {{ r: number, g: number, b: number }} b
 * @returns {number}
 */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ---------------------------------------------------------------------------
// Token reading

/** @param {string} css */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Top-level rules as { prelude, body }; at-rule blocks are returned too.
 * @param {string} css
 */
const topLevelRules = (css) => {
  /** @type {{ prelude: string, body: string }[]} */
  const rules = [];
  let depth = 0;
  let start = 0;
  let prelude = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      if (depth === 0) {
        prelude = css.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        rules.push({ prelude, body: css.slice(start, i) });
        start = i + 1;
      }
    } else if (c === ';' && depth === 0) {
      // A statement at-rule such as @import or @custom-variant.
      start = i + 1;
    }
  }
  return rules;
};

/**
 * The custom properties declared directly in a rule body (not in nested
 * rules).
 * @param {string} body
 * @returns {[string, string][]}
 */
const customProperties = (body) => {
  /** @type {[string, string][]} */
  const out = [];
  let depth = 0;
  let start = 0;
  /** @param {number} end */
  const flush = (end) => {
    const decl = body.slice(start, end).trim();
    const colon = decl.indexOf(':');
    if (decl.startsWith('--') && colon > 0) {
      out.push([
        decl.slice(0, colon).trim(),
        decl
          .slice(colon + 1)
          .replace(/\s+/g, ' ')
          .trim(),
      ]);
    }
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') {
      depth--;
      if (c === '}' && depth === 0) start = i + 1;
    } else if (c === ';' && depth === 0) {
      flush(i);
      start = i + 1;
    }
  }
  flush(body.length);
  return out;
};

/**
 * @param {string} raw
 * @param {Record<string, string>} tokens
 * @param {Set<string>} [seen]
 * @returns {string}
 */
const resolveVars = (raw, tokens, seen = new Set()) =>
  raw.replace(
    /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
    (_, name, fallback) => {
      if (seen.has(name)) throw new Error(`Cyclic custom property ${name}`);
      if (name in tokens) {
        return resolveVars(tokens[name], tokens, new Set([...seen, name]));
      }
      if (fallback !== undefined) return resolveVars(fallback, tokens, seen);
      throw new Error(`Undefined custom property ${name}`);
    },
  );

/**
 * The custom properties in force on the root element for one theme, with
 * every var() resolved. `cssText` is the stylesheets concatenated in cascade
 * order (src/styles/lumen.css, then src/index.css). Light reads the `:root`
 * rules; dark reads `:root` AND `.dark` in source order, because `.dark`
 * sits on the same <html> element and both selectors weigh (0,1,0).
 * At-rules (@media print, @theme, @utility) are ignored.
 * @param {string} cssText
 * @param {Theme} theme
 * @returns {Record<string, string>}
 */
export function readThemeTokens(cssText, theme) {
  /** @type {Record<string, string>} */
  const raw = {};
  for (const { prelude, body } of topLevelRules(stripComments(cssText))) {
    if (prelude.startsWith('@')) continue;
    const selectors = prelude.split(',').map((s) => s.trim());
    const applies =
      selectors.includes(':root') ||
      (theme === 'dark' && selectors.includes('.dark'));
    if (!applies) continue;
    for (const [name, value] of customProperties(body)) raw[name] = value;
  }
  /** @type {Record<string, string>} */
  const resolved = {};
  for (const name of Object.keys(raw)) {
    try {
      resolved[name] = resolveVars(raw[name], raw);
    } catch {
      // A token built from something undefined here is not one of the
      // colours this module measures; leave it out rather than fail.
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// The pairs the UI actually paints

export const TEXT = 4.5;
export const NON_TEXT = 3;

/**
 * @typedef {object} Pair
 * @property {string} label
 * @property {string} fg     a token (`--x`) or a literal colour
 * @property {string[]} on   layers over the page background, bottom first;
 *                           `--x / 0.6` is the token at that opacity
 * @property {string[]} [darkOn] a different stack in dark mode
 * @property {number} min
 */

/**
 * Each pair is a foreground painted over a stack of layers. The bottom layer
 * is always the page background (`--background`); translucent layers are
 * composited upwards, then the foreground over the result.
 * @type {Pair[]}
 */
export const PAIRS = [
  { label: 'Text on page', fg: '--foreground', on: [], min: TEXT },
  { label: 'Muted text on page', fg: '--muted-foreground', on: [], min: TEXT },
  {
    label: 'Muted text on glass-1 (inputs, chips)',
    fg: '--muted-foreground',
    on: ['--lm-glass-1'],
    min: TEXT,
  },
  {
    // input.tsx: `glass-1 ... placeholder:text-muted-foreground dark:bg-input/30`
    label: 'Placeholder on input field',
    fg: '--muted-foreground',
    on: ['--lm-glass-1'],
    darkOn: ['--input / 0.3'],
    min: TEXT,
  },
  {
    label: 'Muted text on card (glass-2)',
    fg: '--muted-foreground',
    on: ['--card'],
    min: TEXT,
  },
  {
    label: 'Muted text on popover (glass-3)',
    fg: '--muted-foreground',
    on: ['--popover'],
    min: TEXT,
  },
  { label: 'Destructive text on page', fg: '--destructive', on: [], min: TEXT },
  {
    label: 'Destructive text on card',
    fg: '--destructive',
    on: ['--card'],
    min: TEXT,
  },
  {
    // button.tsx: `bg-destructive text-white dark:bg-destructive/60`
    label: 'White text on destructive button',
    fg: 'white',
    on: ['--destructive'],
    darkOn: ['--destructive / 0.6'],
    min: TEXT,
  },
  { label: 'Gain on page', fg: '--gain', on: [], min: TEXT },
  { label: 'Loss on page', fg: '--loss', on: [], min: TEXT },
  { label: 'Gain on card', fg: '--gain', on: ['--card'], min: TEXT },
  { label: 'Loss on card', fg: '--loss', on: ['--card'], min: TEXT },
  {
    label: 'Primary button text on primary',
    fg: '--primary-foreground',
    on: ['--primary'],
    min: TEXT,
  },
  { label: 'Focus ring on page', fg: '--ring', on: [], min: NON_TEXT },
  {
    // The only boundary an input or select has (`border-input`).
    label: 'Input border on page',
    fg: '--input',
    on: [],
    min: NON_TEXT,
  },
];

/**
 * @param {Record<string, string>} tokens
 * @param {string} ref
 * @returns {Rgba}
 */
const layer = (tokens, ref) => {
  const [name, opacity] = ref.split('/').map((s) => s.trim());
  let base;
  if (name.startsWith('--')) {
    if (!(name in tokens)) throw new Error(`Token ${name} not found`);
    base = parseCssColor(tokens[name]);
  } else {
    base = parseCssColor(name);
  }
  return opacity === undefined
    ? base
    : { ...base, a: base.a * parseFloat(opacity) };
};

/**
 * @typedef {object} Measurement
 * @property {Theme} theme
 * @property {string} label
 * @property {string} fg
 * @property {string[]} on
 * @property {number} ratio
 * @property {number} min
 * @property {boolean} pass
 */

/**
 * Measures every pair in one theme.
 * @param {string} cssText
 * @param {Theme} theme
 * @returns {Measurement[]}
 */
export function measure(cssText, theme) {
  const tokens = readThemeTokens(cssText, theme);
  const page = layer(tokens, '--background');
  if (page.a < 1) throw new Error('The page background must be opaque');
  return PAIRS.map((pair) => {
    const stack = (theme === 'dark' && pair.darkOn) || pair.on;
    const bg = stack.reduce(
      (under, ref) => composite(layer(tokens, ref), under),
      page,
    );
    const fg = composite(layer(tokens, pair.fg), bg);
    const ratio = contrastRatio(fg, bg);
    return {
      theme,
      label: pair.label,
      fg: pair.fg,
      on: ['--background', ...stack],
      ratio,
      min: pair.min,
      pass: ratio >= pair.min,
    };
  });
}

/**
 * The Markdown table docs/accessibility.md embeds.
 * @param {string} cssText
 * @returns {string}
 */
export function markdownTable(cssText) {
  const rows = [
    '| Theme | Pair | Foreground | Over | Ratio | Needs | Result |',
    '| --- | --- | --- | --- | ---: | ---: | --- |',
  ];
  /** @type {Theme[]} */
  const themes = ['light', 'dark'];
  for (const theme of themes) {
    for (const r of measure(cssText, theme)) {
      const over = r.on.map((o) => `\`${o}\``).join(' + ');
      rows.push(
        `| ${theme} | ${r.label} | \`${r.fg}\` | ${over} | ` +
          `${r.ratio.toFixed(2)}:1 | ${r.min.toFixed(1)}:1 | ` +
          `${r.pass ? 'pass' : 'FAIL'} |`,
      );
    }
  }
  return rows.join('\n');
}
