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
    'setWindowOpenHandler',
    'shell.openExternal',
    'will-navigate',
    'will-attach-webview',
    "'Content-Security-Policy'",
    "host !== 'app'",
    'path.relative(BUILD_DIR, pathToServe)',
    "['http:', 'https:']",
  ])('electron.js contains %s', (literal) => {
    expect(read('public/electron.js')).toContain(literal);
  });

  it('precaches the theme script', () => {
    expect(read('vite.config.ts')).toContain("'theme-init.js'");
  });

  it('electron-builder ships csp.json', () => {
    expect(read('package.json')).toContain('"public/csp.json"');
  });
});
