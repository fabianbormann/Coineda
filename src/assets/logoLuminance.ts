/**
 * How light or dark a token logo is, and whether it needs help in dark mode.
 *
 * Registry logos are raster PNGs in their authors' own colours, so unlike
 * the bundled chain vectors they cannot simply be repainted for a dark
 * theme. They also cannot be left alone: measured across 54 real registry
 * logos on 2026-10-05, 15% are essentially black artwork on transparency -
 * NIGHT's mean luminance is 0.039 - which on this app's dark surface is
 * invisible.
 *
 * Nor can they all be treated the same. The same sample found 6% that are
 * near-white, which would vanish on exactly the light backing plate that
 * rescues the dark ones. So the treatment has to be decided per logo, from
 * the image itself.
 */

/**
 * Below this mean luminance, a logo gets a light plate behind it in dark
 * mode.
 *
 * Derived, not chosen by eye. The dark surface is `--lm-bg` #0b0c10, whose
 * WCAG relative luminance is 0.0037. Clearing a 3:1 contrast ratio - WCAG's
 * bar for non-text graphics - needs a relative luminance of 0.111, which on
 * the simple sRGB-mean scale `meanLuminance` returns is 0.367.
 *
 * Worth knowing how far off intuition was: eyeballing the sample suggested
 * 0.25, which would have left logos at ~1.9:1 untreated and still unreadable.
 */
export const LOGO_NEEDS_PLATE_BELOW = 0.367;

/**
 * Pixels fainter than this are discarded rather than merely down-weighted.
 *
 * Note what this is NOT doing: fully transparent pixels are already
 * excluded, because the alpha weighting below multiplies them by zero. That
 * is what keeps the black left in the colour channels of transparent pixels
 * by most PNG exporters from dragging every measurement to zero.
 *
 * This floor earns its place on a narrower case - a logo with a large,
 * very faint wash at alpha 5 to 30, where thousands of near-invisible
 * pixels can still out-weigh a small opaque mark.
 */
const ALPHA_FLOOR = 32;

/**
 * Mean luminance of a logo's visible pixels, 0 to 1, or null when there is
 * nothing visible to measure.
 *
 * Alpha-weighted and alpha-filtered: a logo is overwhelmingly transparent
 * padding, and counting that padding would drag every measurement toward
 * whatever the fully transparent pixels happen to carry in their colour
 * channels - which for a PNG exported from most tools is black. That alone
 * would classify every logo as dark.
 *
 * Kept pure, over raw RGBA, so the decision this drives is testable without
 * a canvas.
 */
export const meanLuminance = (
  rgba: Uint8ClampedArray | number[],
): number | null => {
  let total = 0;
  let weight = 0;
  for (let index = 0; index + 3 < rgba.length; index += 4) {
    const alpha = rgba[index + 3];
    if (alpha < ALPHA_FLOOR) {
      continue;
    }
    const luminance =
      (0.2126 * rgba[index] +
        0.7152 * rgba[index + 1] +
        0.0722 * rgba[index + 2]) /
      255;
    const share = alpha / 255;
    total += luminance * share;
    weight += share;
  }
  return weight === 0 ? null : total / weight;
};

/** Longest edge the measurement samples at. A logo can be 1080x1080, and
 *  nobody needs a megapixel to answer "is this dark". */
const SAMPLE_EDGE = 32;

const toBlob = (base64: string): Blob => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: 'image/png' });
};

/**
 * Measures a base64 PNG, or returns null where the platform cannot.
 *
 * Null is a real answer and the caller must treat it as "leave the logo
 * alone" rather than guess: an unmeasured logo is far more likely to be an
 * ordinary mid-tone one, where a plate would be unnecessary decoration,
 * than a black one.
 *
 * Everything here is guarded. This runs under jsdom in tests and inside
 * Electron in production, and a decoration must never be able to throw into
 * a balance screen.
 */
export const measureLogoLuminance = async (
  base64: string,
): Promise<number | null> => {
  try {
    if (
      typeof createImageBitmap !== 'function' ||
      typeof OffscreenCanvas !== 'function'
    ) {
      return null;
    }
    const bitmap = await createImageBitmap(toBlob(base64));
    const scale = Math.min(
      1,
      SAMPLE_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context === null) {
      bitmap.close();
      return null;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return meanLuminance(context.getImageData(0, 0, width, height).data);
  } catch {
    return null;
  }
};

/** Whether this logo needs a light plate behind it in dark mode. */
export const needsLightPlate = (
  luminance: number | null | undefined,
): boolean =>
  typeof luminance === 'number' && luminance < LOGO_NEEDS_PLATE_BELOW;
