import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
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
