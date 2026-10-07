import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { APP_VERSION } from '../src/global/version';

const buildDir = path.join(__dirname, '..', 'build');

// File-scoped so every describe block below gets a fresh build. This used to
// live inside 'production build output' only, which meant the three other
// describe blocks (including the service worker assertions) read whatever
// build/ happened to already be on disk - stale or absent - without ever
// running vite build themselves.
beforeAll(() => {
  execSync('npx vite build', {
    cwd: path.join(__dirname, '..'),
    stdio: 'pipe',
  });
}, 180000);

describe('production build output', () => {
  it('references assets relatively so the build works from a subpath and from file://', () => {
    const html = fs.readFileSync(path.join(buildDir, 'index.html'), 'utf8');
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    const assetUrls = urls.filter((url) => url.includes('assets/'));

    expect(assetUrls.length).toBeGreaterThan(0);
    for (const url of assetUrls) {
      expect(url.startsWith('./')).toBe(true);
      expect(url.startsWith('/')).toBe(false);
    }
  });
});

describe('electron production load', () => {
  it('does not load the app shell from a file:// URL', () => {
    // Vite emits `<script type="module" crossorigin>` tags. ES modules and
    // crossorigin fetches are blocked by the browser's CORS checks when the
    // document origin is `file://` (origin "null"), which renders a blank
    // window in the packaged Electron app. public/electron.js must serve
    // the build over a registered custom scheme instead - if this
    // regresses back to `file://${...}`, the window silently goes blank.
    const electronMainPath = path.join(
      __dirname,
      '..',
      'public',
      'electron.js',
    );
    const electronMain = fs.readFileSync(electronMainPath, 'utf8');

    expect(electronMain).not.toMatch(/loadURL\(\s*[^)]*`?file:\/\//s);
    expect(electronMain).not.toContain("'file://");
    expect(electronMain).not.toContain('"file://');
  });

  it('still registers a privileged custom scheme and loads it in production', () => {
    // The negative assertion above only catches a literal revert to
    // file://. It stays green if someone instead deletes the
    // registerSchemesAsPrivileged block wholesale - which is the actual fix
    // for the blank-window regression - so assert the positive shape too.
    const electronMainPath = path.join(
      __dirname,
      '..',
      'public',
      'electron.js',
    );
    const electronMain = fs.readFileSync(electronMainPath, 'utf8');

    expect(electronMain).toContain('registerSchemesAsPrivileged');
    expect(electronMain).toMatch(/standard:\s*true/);
    expect(electronMain).toMatch(/secure:\s*true/);
    // Bounded to the loadURL(...) call's own argument list ([^)]*, matching
    // the file:// assertion above): APP_SCHEME appears elsewhere in this
    // file too (in the protocol.handle registration further down), so an
    // open-ended scan would stay green even if the production branch of
    // this call were replaced with an unconditional localhost URL.
    expect(electronMain).toMatch(/loadURL\(\s*[^)]*APP_SCHEME[^)]*\)/);
  });
});

describe('app version', () => {
  it('is a bare semver, so the release link in the footer resolves', () => {
    // Rewritten: this test used to assert that
    // `'version:1.2.3'.split(':')[1] === '1.2.3'`, which is a property of
    // String.prototype.split and can never fail, and it documented v1's
    // exportData/CoinedaFileInput .cnd header, neither of which exists any
    // more. The real invariant APP_VERSION still has to satisfy is this:
    // AppShell builds a GitHub release URL as `v${APP_VERSION}` and
    // release-please tags releases as `v<semver>`, so a leading 'v', a
    // 'v'-prefixed package version or a prerelease suffix would link to a
    // tag that does not exist.
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(APP_VERSION.startsWith('v')).toBe(false);

    // And that it is genuinely package.json's version, not a value that
    // drifted: release-please bumps package.json only.
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(APP_VERSION).toBe(packageJson.version);
  });

  it('is the version the footer actually links to', () => {
    // Pins the `v`-prefixed tag shape at the one call site that depends on
    // it, so a change there has to be a deliberate one. The link moved from
    // AppSidebar to AppShell when the empty sidebar was removed; this test
    // is what caught that the link had a dependent at all.
    const shell = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'components', 'layout', 'AppShell.tsx'),
      'utf8',
    );
    expect(shell).toContain('releases/tag/v${APP_VERSION}');
  });
});

describe('generated service worker', () => {
  it('emits a service worker and a web manifest', () => {
    expect(fs.existsSync(path.join(buildDir, 'sw.js'))).toBe(true);
    expect(fs.existsSync(path.join(buildDir, 'manifest.webmanifest'))).toBe(
      true,
    );
  });

  it('claims clients and skips waiting, so a returning user cannot be stranded on a stale shell', () => {
    const sw = fs.readFileSync(path.join(buildDir, 'sw.js'), 'utf8');
    expect(sw).toContain('clientsClaim');
    expect(sw).toContain('skipWaiting');
  });

  it('does not cache the CoinGecko API, which fetchPrice already caches itself', () => {
    const sw = fs.readFileSync(path.join(buildDir, 'sw.js'), 'utf8');
    expect(sw).not.toContain('api.coingecko.com');
  });

  it('precaches a font, so self-hosted Inter still renders offline', () => {
    // A prior fix restored fonts to the precache after a glob change
    // (globPatterns missing the woff2 format) silently dropped them again,
    // falling back to a system font offline. Without this assertion that
    // regression is invisible to the test suite.
    const sw = fs.readFileSync(path.join(buildDir, 'sw.js'), 'utf8');
    expect(sw).toMatch(/\.woff2/);
  });

  it('identifies itself as Coineda rather than the create-react-app default', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(buildDir, 'manifest.webmanifest'), 'utf8'),
    );
    expect(manifest.name).toBe('Coineda');
    expect(manifest.short_name).toBe('Coineda');
    expect(manifest.theme_color).toBe('#03A678');
  });
});

describe('chain icon colours survive the Tailwind build', () => {
  /**
   * Asserted against the COMPILED CSS, not the DOM.
   *
   * jsdom applies no Tailwind, so a unit test can only see that an element
   * carries the class `text-[#F7931A]` - which it would carry just as
   * happily if Tailwind had never generated a rule for it. And that is the
   * actual failure mode for an arbitrary-value utility: the class name is
   * in the markup, the stylesheet has nothing matching it, and the icon
   * renders in the inherited text colour with no error anywhere.
   *
   * So this reads the emitted stylesheet and checks the rules exist.
   */
  const css = (): string => {
    const dir = path.join(buildDir, 'assets');
    const file = fs.readdirSync(dir).find((name) => name.endsWith('.css'));
    if (file === undefined) {
      throw new Error('no stylesheet in the build output');
    }
    return fs.readFileSync(path.join(dir, file), 'utf8');
  };

  it('generates a rule for each brand colour', () => {
    const sheet = css();
    // Bitcoin orange, Ethereum graphite, Cardano blue - the three bundled
    // marks, each drawn in its own colour in light mode.
    //
    // The escaped SELECTOR, not the bare hex. A hex can appear in the
    // stylesheet for all sorts of reasons while no rule selects the class
    // the component actually puts in the DOM, which is the exact way an
    // arbitrary-value utility fails: class present, no matching rule, icon
    // silently inherits the text colour.
    for (const hex of ['F7931A', '3C3C3D', '0133AD']) {
      expect(sheet).toContain(`.text-\\[\\#${hex}\\]`);
    }
  });

  it('generates the dark-mode white override, scoped to .dark', () => {
    const sheet = css();
    // The marks go flat white on a dark ground: the brand hexes are
    // mid-tones picked against white paper - Ethereum's #3C3C3D is nearly
    // black - and they read as smudges rather than logos in dark mode.
    //
    // Scoped to `.dark` specifically, which is the class ThemeProvider sets
    // on documentElement. If the variant ever resolved to a bare
    // prefers-color-scheme media query instead, an explicit in-app light
    // choice on a dark OS would wrongly whiten the icons.
    const rule =
      /\.dark[^{}]*\.dark\\:text-white|\.dark\s+\.dark\\:text-white|\.dark\\:text-white/;
    expect(sheet).toMatch(rule);
    const atDark = sheet.slice(sheet.search(/\.dark\\:text-white/));
    expect(atDark.slice(0, 400)).toContain('.dark');
  });
});

describe('app icons', () => {
  /**
   * Reads the top-left pixel's alpha out of a PNG.
   *
   * Worth the twenty lines: "is this icon opaque" is the actual
   * requirement for two of the slots below, and it is silently breakable -
   * pointing a maskable or an apple-touch icon back at the rounded tile
   * looks fine in a file listing and wrong on a phone.
   */
  const topLeftAlpha = (file: string): number => {
    const data = fs.readFileSync(path.join(buildDir, file));
    let pos = 8; // past the PNG signature
    let width = 0;
    let colourType = 0;
    const idat: Buffer[] = [];
    while (pos < data.length) {
      const length = data.readUInt32BE(pos);
      const type = data.toString('ascii', pos + 4, pos + 8);
      const body = data.subarray(pos + 8, pos + 8 + length);
      if (type === 'IHDR') {
        width = body.readUInt32BE(0);
        colourType = body[9];
      } else if (type === 'IDAT') {
        idat.push(body);
      } else if (type === 'IEND') {
        break;
      }
      pos += 12 + length;
    }
    expect(width).toBeGreaterThan(0);
    // Colour type 2 is truecolour with NO alpha channel at all, which is the
    // strongest possible answer to "is this opaque" - there is nowhere for
    // transparency to live. rsvg emits it whenever the art is fully opaque,
    // which is exactly the case these assertions care about.
    if (colourType === 2) {
      return 255;
    }
    expect(colourType).toBe(6); // 8-bit RGBA, the only other form rsvg writes
    const raw = zlib.inflateSync(Buffer.concat(idat));
    // Byte 0 of a scanline is its filter type. On the FIRST row every filter
    // either passes the byte through or subtracts a pixel to its left, and
    // for the very first pixel there is nothing to its left - so byte 4 is
    // the alpha channel verbatim, whichever filter was used.
    return raw[4];
  };

  it('ships every icon the page and the manifest point at', () => {
    const html = fs.readFileSync(path.join(buildDir, 'index.html'), 'utf8');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(buildDir, 'manifest.webmanifest'), 'utf8'),
    ) as { icons: { src: string }[] };

    const referenced = [
      ...[...html.matchAll(/(?:href|src)="\/?([^"]+\.(?:png|ico|svg))"/g)].map(
        (match) => match[1],
      ),
      ...manifest.icons.map((icon) => icon.src),
    ];
    expect(referenced.length).toBeGreaterThan(3);
    for (const file of new Set(referenced)) {
      expect(
        fs.existsSync(path.join(buildDir, file)),
        `${file} is referenced but not in the build`,
      ).toBe(true);
    }
  });

  it('gives the maskable slot a FULL-BLEED icon, not the rounded tile', () => {
    // Android masks a maskable icon itself. Hand it the pre-rounded tile and
    // its corners are cut twice, leaving the mark inside a shrunken blob -
    // and the tile's corners are transparent, so they come back black.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(buildDir, 'manifest.webmanifest'), 'utf8'),
    ) as { icons: { src: string; purpose?: string }[] };
    const maskable = manifest.icons.find((icon) => icon.purpose === 'maskable');
    expect(maskable).toBeDefined();
    expect(topLeftAlpha(maskable!.src)).toBe(255);

    // And it is a different image from the ordinary one, which is the shape
    // this regression takes: both slots pointed at the same file.
    const plain = manifest.icons.find((icon) => icon.purpose === undefined);
    expect(maskable!.src).not.toBe(plain!.src);
    expect(topLeftAlpha(plain!.src)).toBe(0);
  });

  it('gives iOS an opaque home-screen icon', () => {
    // iOS ignores alpha on an apple-touch-icon and fills transparency with
    // black, so a rounded tile with transparent corners gets black ones.
    const html = fs.readFileSync(path.join(buildDir, 'index.html'), 'utf8');
    const match = /rel="apple-touch-icon"\s+href="\/?([^"]+)"/.exec(html);
    expect(match).not.toBeNull();
    expect(topLeftAlpha(match![1])).toBe(255);
  });

  it('carries small frames in the .ico, for the tab strip that reads it', () => {
    // The previous favicon.ico held one 192x192 frame and weighed 152 KB, so
    // every 16px tab rendered a downscale of it. An .ico exists precisely to
    // carry the small sizes ready-made.
    const ico = fs.readFileSync(path.join(buildDir, 'favicon.ico'));
    const count = ico.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(3);
    // Width and height live in the directory entry; 0 means 256.
    const sizes = Array.from(
      { length: count },
      (_, i) => ico[6 + i * 16] || 256,
    );
    expect(sizes).toContain(16);
    expect(sizes).toContain(32);
    expect(ico.length).toBeLessThan(80_000);
  });
});

describe('the print stylesheet survives the build', () => {
  const css = (): string => {
    const dir = path.join(buildDir, 'assets');
    const file = fs.readdirSync(dir).find((name) => name.endsWith('.css'));
    if (file === undefined) {
      throw new Error('no stylesheet in the build output');
    }
    return fs.readFileSync(path.join(dir, file), 'utf8');
  };

  it('repaints the theme tokens for paper, dark mode included', () => {
    // THE one that matters. Every surface in this app reads its colour
    // through Lumen's --lm-* tokens, so printing is a token override - and
    // if `.dark` is not overridden alongside `:root`, a report printed from
    // dark mode is white text on a background the printer drops, i.e. a
    // blank sheet with a few invisible figures on it.
    const sheet = css();
    const start = sheet.indexOf('--lm-blob:0');
    expect(start).toBeGreaterThan(-1);
    const block = sheet.slice(sheet.lastIndexOf('@media print', start), start);
    expect(block).toContain(':root.dark');
    expect(block).toContain('--lm-bg:#fff');
    // The frosted tiers have nothing to sit over on paper.
    expect(block).toContain('--lm-glass-2:transparent');
  });

  it('keeps a disposal line whole across a page break', () => {
    // Split, the figures land on one page and the sentence explaining them
    // on the next.
    expect(css()).toContain('break-inside:avoid');
  });

  /**
   * The four defects a real export was measured against, each pinned to the
   * rule that fixes it. Measured on the export that prompted them: the text
   * block ran 209.9mm wide on a 210mm page, border pixels outnumbered text
   * pixels 6.6 to 1, and with background graphics enabled the brand's conic
   * gradient printed behind every figure.
   */
  it('keeps text-base a font size, not a colour', () => {
    // Tailwind v4 generates a `text-{name}` COLOUR utility for every
    // `--color-*` the theme registers, and the generated colour wins over
    // the built-in font-size scale. Lumen registered a colour literally
    // named `base`, so `.text-base` compiled to
    // `color:var(--color-base)` - which is the PAGE BACKGROUND. Every
    // field carrying shadcn's standard `text-base` therefore painted what
    // a person typed in the exact colour of the surface behind it:
    // measured at 1.06:1 contrast in light mode and 2.29:1 in dark, in
    // every input in the app, while the placeholder (which has its own
    // explicit class) stayed perfectly legible.
    const sheet = css();
    const rule = /\.text-base\{([^}]*)\}/.exec(sheet)?.[1];
    expect(rule, 'no .text-base rule in the build').toBeDefined();
    expect(rule).toContain('font-size');
    expect(rule).not.toContain('color:');
  });

  it('registers no theme colour that shadows a font-size utility', () => {
    // The generalisation of the bug above: any `--color-<size>` silently
    // turns that size utility into a colour. Checked against the whole
    // scale rather than against `base` alone, because the next collision
    // would be just as invisible.
    const lumen = fs.readFileSync(
      path.join(import.meta.dirname, '..', 'src', 'styles', 'lumen.css'),
      'utf8',
    );
    const sizes = [
      'xs',
      'sm',
      'base',
      'lg',
      'xl',
      '2xl',
      '3xl',
      '4xl',
      '5xl',
      '6xl',
      '7xl',
      '8xl',
      '9xl',
    ];
    const declared = [...lumen.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map(
      (m) => m[1],
    );
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((name) => sizes.includes(name))).toEqual([]);
  });

  it('gives the printed document a measure that survives the shell', () => {
    const sheet = css();
    // `main > *` carries `max-width:none!important` and AppShell renders the
    // routed screen as a direct child of <main>, so this one has to be
    // important too or the measure silently loses - invisible in any test
    // that renders the screen without its shell.
    expect(sheet).toMatch(
      /\[data-print=["']?document["']?\]\{[^}]*max-width:165mm\s*!important/,
    );
    expect(sheet).toMatch(
      /\[data-print=["']?document["']?\]\{[^}]*margin:0 auto\s*!important/,
    );
  });

  it('neutralises the brand gradient, not only the page wash', () => {
    // --lm-blob alone left --lm-rim standing, and every Card carries `rim`.
    const printBlock = css().slice(css().indexOf('@media print'));
    expect(printBlock).toMatch(/--lm-rim:\s*none/);
    expect(printBlock).toMatch(/--lm-blob:\s*0/);
    expect(printBlock).toMatch(/background-image:none\s*!important/);
  });

  it("sets the document in near-black, not the screen's muted grey", () => {
    // In a tax report the "muted" text IS the content - every rationale,
    // every consumed lot, every line of the method sheet - so a tone chosen
    // to recede behind a UI made the whole document read as grey.
    //
    // Anchored on the rule that declares --lm-blob:0, which only the print
    // palette does. Slicing from the first '@media print' instead landed in
    // Lumen's own light palette - the built sheet has TWO print blocks -
    // and the assertion then passed against a value it was never meant to
    // read, including against the stylesheet it was written to reject.
    const sheet = css();
    const anchor = sheet.indexOf('--lm-blob:0');
    expect(anchor).toBeGreaterThan(-1);
    const rule = sheet.slice(
      sheet.lastIndexOf('{', anchor),
      sheet.indexOf('}', anchor),
    );
    const mute = /--lm-mute:\s*(#[0-9a-f]{6})\b/i.exec(rule)?.[1];
    expect(mute, 'no plain --lm-mute hex in the print palette').toBeDefined();
    expect(parseInt(mute!.slice(1, 3), 16)).toBeLessThanOrEqual(0x22);
  });

  it('turns the cards into sections rather than boxes', () => {
    const printBlock = css().slice(css().indexOf('@media print'));
    expect(printBlock).toMatch(
      /\[data-slot=["']?card["']?\]\{[^}]*border:0\s*!important/,
    );
    expect(printBlock).toMatch(/break-inside:avoid/);
  });

  it('generates a rule for every print variant the source actually uses', () => {
    // A `print:` variant that Tailwind never saw is a class in the markup
    // with no rule behind it: the controls would print and the document
    // header would not - silently, and only on paper.
    //
    // Derived from the source rather than hardcoded. The hardcoded version
    // listed `print:hidden` and `print:block`, and broke the day the
    // document header became a flex column - a true regression report about
    // nothing, while a genuinely new variant used in one place would have
    // slipped past it unnoticed. What matters is the invariant: whatever
    // the markup asks for, the stylesheet has.
    const sheet = css();
    const used = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.tsx?$/.test(entry.name)) {
          for (const match of fs
            .readFileSync(full, 'utf8')
            .matchAll(/\bprint:([a-z0-9-]+)\b/g)) {
            used.add(match[1]);
          }
        }
      }
    };
    walk(path.join(import.meta.dirname, '..', 'src'));

    expect(used.size).toBeGreaterThan(0);
    for (const variant of used) {
      expect(sheet, `no rule generated for print:${variant}`).toContain(
        `.print\\:${variant}{`,
      );
    }
  });
});
