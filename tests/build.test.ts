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
  it('is a bare semver, so the .cnd export header stays parseable on re-import', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);

    // exportData writes 'version:' + APP_VERSION into the <header> block, and
    // CoinedaFileInput.readHeader recovers it with versionString.split(':')[1].
    const headerLine = `version:${APP_VERSION}`;
    expect(headerLine.split(':')[1]).toBe(APP_VERSION);
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

  it('identifies itself as Coineda rather than the create-react-app default', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(buildDir, 'manifest.webmanifest'), 'utf8'),
    );
    expect(manifest.name).toBe('Coineda');
    expect(manifest.short_name).toBe('Coineda');
    expect(manifest.theme_color).toBe('#03A678');
  });
});
