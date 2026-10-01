import { describe, it, expect } from 'vitest';
import { registry } from '@/sources/registry';
import en from '../src/translations/en.json';
import de from '../src/translations/de.json';

/**
 * The mechanical half of the module merge gate.
 *
 * `runConformance` is the real gate, but nothing iterated the registry: it
 * was called from one hand-written test per module, so a module added to
 * src/sources/registry.ts WITHOUT its own test passed CI silently - which
 * defeats the point of having a gate at all. This file iterates the registry
 * itself and asserts everything about a manifest that can be checked with no
 * network access and no fixtures.
 *
 * It deliberately does NOT run `runConformance` over the registry. That
 * needs recorded per-module fixtures, which only the contributor who wrote
 * the module can supply - see docs/modules/writing-a-source-module.md, which
 * states that a module's pull request must include its own conformance test.
 * This file is the floor, not a substitute for that.
 */
const enKeys = new Set(Object.keys(en.translation));
const deKeys = new Set(Object.keys(de.translation));

describe('every module in the registry', () => {
  it('is registered at all, so this gate is not vacuous', () => {
    // Without this, an empty registry would make every it.each below pass
    // by iterating nothing.
    expect(registry.length).toBeGreaterThan(0);
  });

  it('has ids that are unique across the whole registry', () => {
    // findModule() resolves a stored source's moduleId by linear search, so
    // a duplicate id would silently route one user's source at another
    // module's fetchEvents.
    const ids = registry.map((module) => module.manifest.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  describe.each(
    registry.map((module) => [module.manifest.id, module] as const),
  )('%s', (_id, module) => {
    const { manifest } = module;

    it('declares a non-empty, stable-looking id', () => {
      expect(manifest.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    });

    it('declares its kind', () => {
      expect(['chain', 'exchange']).toContain(manifest.kind);
    });

    it('declares at least one field, so the dialog can collect something', () => {
      expect(manifest.fields.length).toBeGreaterThan(0);
    });

    it('names its fields uniquely', () => {
      // Two fields with the same name collapse onto one entry in the
      // dialog's `config` object, silently dropping one of them.
      const names = manifest.fields.map((field) => field.name);
      expect(names).toEqual([...new Set(names)]);
    });

    it('declares at least one event kind it emits', () => {
      expect(manifest.emits.length).toBeGreaterThan(0);
    });

    it('keys its own label in both locale files', () => {
      // AddSourceDialog renders every one of these through t(), so a
      // missing key ships the raw English string to a German user.
      expect(enKeys).toContain(manifest.label);
      expect(deKeys).toContain(manifest.label);
    });

    it.each(manifest.fields.map((field) => [field.name, field] as const))(
      'keys the %s field label and help in both locale files',
      (_name, field) => {
        expect(enKeys).toContain(field.label);
        expect(deKeys).toContain(field.label);
        expect(enKeys).toContain(field.help);
        expect(deKeys).toContain(field.help);
      },
    );

    it('exposes probe and fetchEvents', () => {
      expect(typeof module.probe).toBe('function');
      expect(typeof module.fetchEvents).toBe('function');
    });
  });
});
