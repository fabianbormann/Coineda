import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { fileRegistry } from '@/sources/csv/registry';
import { checkDerivedEvent } from '@/sources/conformance';
import en from '../src/translations/en.json';
import de from '../src/translations/de.json';

/**
 * The mechanical gate for file modules, mirroring tests/registry.test.ts for
 * pull modules: a module added to fileRegistry without its own test is still
 * held to the manifest, sniff-safety and parse-shape rules, and to not
 * being claimed by another importer's sniff.
 */
const enKeys = new Set(Object.keys(en.translation));
const deKeys = new Set(Object.keys(de.translation));

// The first .csv in the module's own fixtures directory (Kraken also ships
// .zip fixtures, which are not text).
const fixtureOf = (id: string): string => {
  const dir = join(process.cwd(), 'src', 'sources', id, 'fixtures');
  const file = readdirSync(dir)
    .filter((name) => name.endsWith('.csv'))
    .sort()[0];
  return readFileSync(join(dir, file), 'utf8');
};

describe('every module in the file registry', () => {
  it('is registered at all, so this gate is not vacuous', () => {
    expect(fileRegistry.length).toBeGreaterThan(0);
  });

  it('has unique ids', () => {
    const ids = fileRegistry.map((m) => m.manifest.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it('keys the mapped-CSV label and help in both locale files', () => {
    const mapped = fileRegistry.find((m) => m.manifest.id === 'mapped-csv')!;
    for (const key of [mapped.manifest.label, mapped.manifest.help]) {
      expect(enKeys).toContain(key);
      expect(deKeys).toContain(key);
    }
  });

  // The mapped-CSV module has no fixture of its own and is never sniffed: it
  // parses only with a user mapping, and tests/mappedCsv.test.ts covers it.
  describe.each(
    fileRegistry
      .filter((m) => m.manifest.id !== 'mapped-csv')
      .map((m) => [m.manifest.id, m] as const),
  )('%s', (id, module) => {
    const { manifest } = module;

    it('has a kebab-case id and declares what it emits', () => {
      expect(manifest.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(manifest.emits.length).toBeGreaterThan(0);
    });

    it('keys its label and help in both locale files', () => {
      for (const key of [manifest.label, manifest.help]) {
        expect(enKeys).toContain(key);
        expect(deKeys).toContain(key);
      }
    });

    it.each([
      ['an empty string', ''],
      ['unrelated CSV', 'garbage,,,\n'],
      ['control characters', '\u0000\u0001'],
    ])('refuses %s without throwing', (_name, text) => {
      expect(module.sniff(text)).toBe(false);
    });

    it('parses its fixture into well-formed derived events', () => {
      const { events } = module.parse(fixtureOf(id));
      expect(events.length).toBeGreaterThan(0);
      const seen = new Set<string>();
      for (const event of events) {
        checkDerivedEvent(event, manifest);
        expect(event.origin).toBe('derived');
        expect(Number.isFinite(event.timestamp)).toBe(true);
        for (const leg of event.legs) {
          expect(leg.amount).toMatch(
            leg.assetId.startsWith('fiat:') ? /^\d+(\.\d+)?$/ : /^\d+$/,
          );
        }
        expect(seen.has(event.externalId)).toBe(false);
        seen.add(event.externalId);
      }
    });

    it('emits trades with both an in and an out principal leg', () => {
      for (const event of module.parse(fixtureOf(id)).events) {
        if (event.kind === 'trade') {
          checkDerivedEvent(event, manifest);
        }
      }
    });

    it('is the only module whose sniff accepts its fixture', () => {
      const text = fixtureOf(id);
      expect(module.sniff(text)).toBe(true);
      const claimants = fileRegistry
        .filter((other) => other !== module && other.sniff(text))
        .map((other) => other.manifest.id);
      expect(claimants).toEqual([]);
    });
  });
});
