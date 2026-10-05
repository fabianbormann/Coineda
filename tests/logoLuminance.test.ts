import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  LOGO_NEEDS_PLATE_BELOW,
  meanLuminance,
  measureLogoLuminance,
  needsLightPlate,
} from '@/assets/logoLuminance';
import { assetMarkOf } from '@/components/money/AssetIcon';
import type { TokenMeta } from '@/assets/tokenRegistry';

/**
 * Deciding, per logo, whether it survives a dark background.
 *
 * Registry logos are raster PNGs in their authors' colours, so they cannot
 * be repainted the way the bundled chain vectors are. Measured across 54
 * real registry logos: 15 per cent are essentially black artwork, invisible
 * on this app's dark surface, and 6 per cent are near-white and would
 * vanish on the light plate that rescues the first group. One blanket
 * treatment cannot be right for both, so the decision comes from the image.
 */

/** Tiny 4x4 RGBA PNGs, built by hand and measured with an independent
 *  decoder outside this repo, so the expected values below are not simply
 *  whatever the implementation happens to produce. */
const BLACK_ON_TRANSPARENT =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEElEQVR4nGNgYGD4j4ZJBQDnXAP9B88XOAAAAABJRU5ErkJggg==';
const WHITE_ON_TRANSPARENT =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAADklEQVR4nGP4jwYYSAcAtLkP8QATZHwAAAAASUVORK5CYII=';

const rgba = (pixels: number[][]): number[] => pixels.flat();

describe('meanLuminance', () => {
  it('measures a mid-tone against an independently computed value', () => {
    // 8 px of (200,60,60) and 8 of (60,120,200), all opaque. The external
    // decoder puts this at 0.3976.
    const pixels = [
      ...Array.from({ length: 8 }, () => [200, 60, 60, 255]),
      ...Array.from({ length: 8 }, () => [60, 120, 200, 255]),
    ];
    expect(meanLuminance(rgba(pixels))).toBeCloseTo(0.3976, 3);
  });

  it('ignores transparent padding instead of counting it as black', () => {
    // A logo is mostly transparent padding, and most PNG exporters leave
    // black in the colour channels of fully transparent pixels - so
    // counting them drags every measurement toward zero and classifies
    // every logo, white ones included, as dark. The alpha WEIGHTING is what
    // prevents that, not the floor; the floor has its own test below.
    const white = [
      [255, 255, 255, 255],
      [255, 255, 255, 255],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    // Not exactly 1: the three sRGB coefficients sum to 0.9999999...
    expect(meanLuminance(rgba(white))).toBeCloseTo(1, 6);
    // The point of the test is that it is nowhere near the 0.333 that
    // counting four black transparent pixels would give.
    expect(meanLuminance(rgba(white))).toBeGreaterThan(0.99);
  });

  it('discards a near-invisible pixel rather than down-weighting it', () => {
    // What ALPHA_FLOOR is actually for, which is narrower than it looks:
    // fully transparent pixels are already excluded by the weighting, since
    // alpha 0 multiplies to nothing. The floor matters for a faint wash -
    // thousands of pixels at alpha 5 to 30 can out-weigh a small opaque
    // mark. One black pixel at alpha 16 beside one opaque white pixel
    // drags the mean to about 0.94 if merely weighted, and leaves it at 1
    // if discarded.
    const faint = [
      [255, 255, 255, 255],
      [0, 0, 0, 16],
    ];
    expect(meanLuminance(rgba(faint))).toBeGreaterThan(0.99);
  });

  it('weights a half-transparent pixel by its alpha', () => {
    const half = [
      [255, 255, 255, 255],
      [0, 0, 0, 128],
    ];
    // The white pixel counts fully, the half-opaque black one half as much.
    expect(meanLuminance(rgba(half))).toBeCloseTo(1 / (1 + 128 / 255), 3);
  });

  it('returns null when nothing is visible', () => {
    // Null is a real answer, distinct from zero: zero means "measured, and
    // it is black", null means "no measurement", and the two lead to
    // different treatment.
    expect(
      meanLuminance(
        rgba([
          [0, 0, 0, 0],
          [12, 34, 56, 0],
        ]),
      ),
    ).toBeNull();
    expect(meanLuminance([])).toBeNull();
  });
});

describe('the plate threshold', () => {
  it('is derived from a 3:1 contrast ratio, not picked by eye', () => {
    // The dark surface is --lm-bg #0b0c10, relative luminance 0.0037.
    // Clearing 3:1 - WCAG's bar for non-text graphics - needs relative
    // luminance 0.111, which on this sRGB-mean scale is 0.367.
    //
    // Pinned because eyeballing the sample suggested 0.25, which leaves
    // logos at about 1.9:1 untreated and still unreadable.
    expect(LOGO_NEEDS_PLATE_BELOW).toBeCloseTo(0.367, 3);

    const srgbToLinear = (channel: number) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    const surface =
      srgbToLinear(0x0b / 255) * 0.2126 +
      srgbToLinear(0x0c / 255) * 0.7152 +
      srgbToLinear(0x10 / 255) * 0.0722;
    const ratio =
      (srgbToLinear(LOGO_NEEDS_PLATE_BELOW) + 0.05) / (surface + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(2.95);
    expect(ratio).toBeLessThan(3.2);
  });

  it('plates NIGHT and leaves a near-white logo alone', () => {
    // NIGHT, measured live: 0.039. Its contrast against the dark surface is
    // about 0.99:1 - logo and background are the same brightness.
    expect(needsLightPlate(0.039)).toBe(true);
    // A near-white logo is exactly what the plate would destroy.
    expect(needsLightPlate(0.786)).toBe(false);
  });

  it('leaves an unmeasured logo alone rather than guessing', () => {
    // An unmeasured logo is far likelier to be an ordinary mid-tone, where
    // a plate is pointless decoration, than a black one.
    expect(needsLightPlate(null)).toBe(false);
    expect(needsLightPlate(undefined)).toBe(false);
  });

  it('treats the boundary consistently', () => {
    expect(needsLightPlate(LOGO_NEEDS_PLATE_BELOW - 0.001)).toBe(true);
    expect(needsLightPlate(LOGO_NEEDS_PLATE_BELOW)).toBe(false);
  });
});

describe('measureLogoLuminance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null where the platform cannot decode at all', async () => {
    // jsdom has neither createImageBitmap nor OffscreenCanvas, so this is
    // the "platform says no" path - and only that path.
    await expect(
      measureLogoLuminance(BLACK_ON_TRANSPARENT),
    ).resolves.toBeNull();
    await expect(measureLogoLuminance('not base64 at all')).resolves.toBeNull();
    await expect(measureLogoLuminance('')).resolves.toBeNull();
  });

  it('degrades to null when decoding throws, rather than rejecting', async () => {
    // The guard above short-circuits before anything risky runs, so it does
    // NOT exercise the catch. This stubs the APIs into existence and makes
    // the decode throw - a corrupt or unsupported PNG - which is the case
    // that would otherwise reject into a balance screen for a decoration.
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('corrupt image');
      }),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return null;
        }
      },
    );
    await expect(
      measureLogoLuminance(BLACK_ON_TRANSPARENT),
    ).resolves.toBeNull();
  });

  it('measures through a canvas when the platform provides one', async () => {
    // Two opaque white pixels, served through stubbed browser APIs, so the
    // decode path itself runs rather than only its guards.
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 2, height: 1, close: () => {} })),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return {
            drawImage: () => {},
            getImageData: () => ({
              data: new Uint8ClampedArray([
                255, 255, 255, 255, 255, 255, 255, 255,
              ]),
            }),
          };
        }
      },
    );
    await expect(
      measureLogoLuminance(BLACK_ON_TRANSPARENT),
    ).resolves.toBeCloseTo(1, 6);
  });
});

describe('what the mark carries', () => {
  const meta = (overrides: Partial<TokenMeta>): TokenMeta => ({
    subject: 'abc',
    name: null,
    ticker: 'TKN',
    decimals: null,
    logoPng: BLACK_ON_TRANSPARENT,
    ...overrides,
  });

  it('flags a dark logo for a plate', () => {
    expect(assetMarkOf('cardano:abc', meta({ logoLuminance: 0.039 }))).toEqual({
      kind: 'png',
      base64: BLACK_ON_TRANSPARENT,
      needsPlate: true,
    });
  });

  it('does not flag a light one', () => {
    expect(
      assetMarkOf(
        'cardano:abc',
        meta({ logoPng: WHITE_ON_TRANSPARENT, logoLuminance: 1 }),
      ),
    ).toMatchObject({ needsPlate: false });
  });

  it('never plates a bundled chain vector', () => {
    // Those are repainted through currentColor instead, so a plate would be
    // a white disc behind an already-white glyph.
    expect(assetMarkOf('bitcoin:native')).toMatchObject({ kind: 'vector' });
  });
});
