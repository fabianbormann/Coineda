import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

const POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'none'";

describe('shell security gate', () => {
  it('csp.json carries the agreed policy', () => {
    expect(JSON.parse(read('public/csp.json')).policy).toBe(POLICY);
  });

  it('index.html has no inline script and loads theme-init.js', () => {
    const html = read('index.html');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).toContain('theme-init.js');
  });

  it('theme-init.js keeps the pre-paint behaviour', () => {
    const js = read('public/theme-init.js');
    expect(js).toContain('coineda.theme');
    expect(js).toContain('prefers-color-scheme: dark');
  });

  it.each([
    'contextIsolation: true',
    'nodeIntegration: false',
    'sandbox: true',
    'webSecurity: true',
    // Electron's spellchecker downloads hunspell dictionaries from a Google
    // CDN (Linux, and Windows with hunspell): an egress outside the inventory.
    'spellcheck: false',
    'setWindowOpenHandler',
    'shell.openExternal',
    'will-navigate',
    'will-attach-webview',
    "'Content-Security-Policy'",
    "host !== 'app'",
    'path.relative(BUILD_DIR, pathToServe)',
    "['http:', 'https:']",
    // What the measures do, not only that they are named.
    "{ action: 'deny' }",
    'devTools: isDev',
    "require('./csp.json')",
    "headers.set('Content-Security-Policy', policy)",
    "withCsp(new Response('Forbidden', { status: 403 }))",
    "withCsp(new Response('Bad Request', { status: 400 }))",
    'shell.openExternal(target).catch(',
    'standard: true',
    'secure: true',
    'setMenu(null)',
    // Node's URL gives origin 'null' for coineda://, so compare the parts.
    "protocol === 'coineda:'",
    "host === 'app'",
    "origin === 'http://localhost:3000'",
    'setPermissionRequestHandler',
    'setPermissionCheckHandler',
    "permission === 'media'",
  ])('electron.js contains %s', (literal) => {
    expect(read('public/electron.js')).toContain(literal);
  });

  it('cancels webview attachment', () => {
    expect(read('public/electron.js')).toMatch(
      /'will-attach-webview',\s*\(event\)\s*=>\s*event\.preventDefault\(\)/,
    );
  });

  it('electron.js takes its policy from csp.json, which is the spec string', () => {
    const js = read('public/electron.js');
    expect(js).toContain("const { policy } = require('./csp.json');");
    expect(js).not.toContain("default-src 'self'");
    expect(JSON.parse(read('public/csp.json')).policy).toBe(POLICY);
  });

  it('index.html suppresses the Referer header', () => {
    expect(read('index.html')).toContain(
      '<meta name="referrer" content="no-referrer" />',
    );
  });

  it('precaches the theme script', () => {
    expect(read('vite.config.ts')).toContain("'theme-init.js'");
  });

  it('electron-builder ships csp.json', () => {
    expect(read('package.json')).toContain('"public/csp.json"');
  });
});
