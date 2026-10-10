import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const root = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const readYaml = (rel: string) => parse(read(rel)) as Record<string, any>;

const pkg = JSON.parse(read('package.json')) as {
  version: string;
  license: string;
};
const text = read('publiccode.yml');
const pc = readYaml('publiccode.yml');

// publiccode.yml 0.7.0 enumerations
const PLATFORMS = ['web', 'windows', 'mac', 'linux', 'ios', 'android'];
const STATUSES = ['concept', 'development', 'beta', 'stable', 'obsolete'];
const SOFTWARE_TYPES = [
  'standalone/mobile',
  'standalone/iot',
  'standalone/desktop',
  'standalone/web',
  'standalone/backend',
  'standalone/other',
  'addon',
  'library',
  'configurationFiles',
];
const MAINTENANCE_TYPES = ['internal', 'contract', 'community', 'none'];
// The subsets this project chose from the 0.7.0 lists
const CATEGORIES = ['taxes-management', 'financial-reporting'];
const SCOPES = ['finance-and-economic-development', 'government'];
const DEPRECATED_KEYS = [
  'monochromeLogo',
  'inputTypes',
  'outputTypes',
  'legal.repoOwner',
  'legal.authorsFile',
  'description.en.genericName',
  'description.de.genericName',
];

const get = (obj: any, dotted: string) =>
  dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

describe('publiccode.yml', () => {
  it('carries the mandatory keys', () => {
    expect(pc.publiccodeYmlVersion).toBe('0.4');
    expect(pc.name).toBe('Coineda');
    expect(pc.url).toMatch(/^https:\/\//);
    expect(pc.platforms.length).toBeGreaterThan(0);
    expect(pc.developmentStatus).toBeTruthy();
    expect(pc.softwareType).toBeTruthy();
    expect(pc.description).toBeTruthy();
    expect(pc.legal?.license).toBeTruthy();
    expect(pc.maintenance?.type).toBeTruthy();
    expect(pc.localisation).toBeTruthy();
  });

  it('uses only values from the standard', () => {
    for (const p of pc.platforms) expect(PLATFORMS).toContain(p);
    expect(STATUSES).toContain(pc.developmentStatus);
    expect(SOFTWARE_TYPES).toContain(pc.softwareType);
    expect(MAINTENANCE_TYPES).toContain(pc.maintenance.type);
    for (const c of pc.categories) expect(CATEGORIES).toContain(c);
    for (const s of pc.intendedAudience.scope) expect(SCOPES).toContain(s);
    for (const c of pc.intendedAudience.countries) {
      expect(c).toMatch(/^[a-z]{2}$/);
    }
    expect(pc.localisation.localisationReady).toBe(true);
  });

  it('names a contact for a community-maintained project', () => {
    expect(pc.maintenance.contacts.length).toBeGreaterThan(0);
    for (const c of pc.maintenance.contacts) expect(c.name).toBeTruthy();
  });

  it.each(['en', 'de'])('describes the project in %s', (lang) => {
    const d = pc.description[lang];
    expect(d.shortDescription.length).toBeGreaterThan(0);
    expect(d.shortDescription.length).toBeLessThanOrEqual(150);
    expect(d.longDescription.length).toBeGreaterThanOrEqual(150);
    expect(d.longDescription.length).toBeLessThanOrEqual(10000);
    expect(d.features.length).toBeGreaterThanOrEqual(8);
    expect(d.features.length).toBeLessThanOrEqual(12);
    for (const f of d.features) expect(f.trim().length).toBeGreaterThan(0);
    expect(d.documentation).toMatch(/^https:\/\//);
    expect(d.screenshots.length).toBeGreaterThan(0);
    for (const s of d.screenshots) {
      expect(fs.existsSync(path.join(root, s))).toBe(true);
    }
  });

  it('uses no deprecated key', () => {
    for (const key of DEPRECATED_KEYS) expect(get(pc, key)).toBeUndefined();
  });

  it('points at files that exist', () => {
    expect(fs.existsSync(path.join(root, pc.logo))).toBe(true);
  });

  it('lists exactly the interface languages', () => {
    const locales = fs
      .readdirSync(path.join(root, 'src/translations'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    expect([...pc.localisation.availableLanguages].sort()).toEqual(locales);
    expect(Object.keys(pc.description).sort()).toEqual(locales);
  });

  it('matches package.json', () => {
    expect(pc.softwareVersion).toBe(pkg.version);
    expect(pc.legal.license).toBe(pkg.license);
  });

  it('keeps the release-please annotation on the version line', () => {
    const line = text.split('\n').find((l) => l.startsWith('softwareVersion:'));
    expect(line).toBeDefined();
    expect(line).toMatch(/#\s*x-release-please-version\s*$/);
  });
});

describe('release workflow', () => {
  it('bumps publiccode.yml with release-please', () => {
    const wf = readYaml('.github/workflows/release.yml');
    const steps = wf.jobs.create_release.steps as any[];
    const step = steps.find((s) =>
      String(s.uses ?? '').includes('release-please-action'),
    );
    expect(step).toBeDefined();
    expect(String(step.with['extra-files'])).toContain('publiccode.yml');
  });
});

describe('.gitlab-ci.yml', () => {
  const runCommands = (steps: any[]) =>
    steps.map((s) => s.run).filter((r): r is string => typeof r === 'string');

  it('runs the same commands as test.yml', () => {
    const gh = readYaml('.github/workflows/test.yml');
    const expected = runCommands(gh.jobs.test.steps);
    expect(expected).toEqual([
      'npm ci',
      'npm run lint',
      'npm run format:check',
      'npx tsc --noEmit',
      'npx vitest run',
    ]);

    const gl = readYaml('.gitlab-ci.yml');
    const jobs = Object.values(gl).filter(
      (v: any) => v && typeof v === 'object' && v.script,
    ) as any[];
    expect(jobs.length).toBeGreaterThan(0);
    const scripts = jobs.flatMap((j) => j.script as string[]);
    expect(scripts).toEqual(expected);
    expect(jobs[0].stage).toBe('test');
  });
});
