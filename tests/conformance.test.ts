import { describe, it, expect } from 'vitest';
import type { DerivedEvent, SourceModule } from '@/sources/types';
import { runConformance } from '@/sources/conformance';

const manifest = {
  id: 'test-module',
  kind: 'chain' as const,
  label: 'Test',
  fields: [
    { name: 'address', label: 'Address', type: 'address' as const, help: 'h' },
  ],
  needsRelay: false,
  // Declares both kinds the tests below emit legitimately. The
  // "does not declare" test deliberately emits 'fee', which is absent here -
  // note checkEvent tests the manifest BEFORE it tests trade directions, so a
  // kind that is both undeclared and malformed reports the undeclared error.
  emits: ['reward' as const, 'trade' as const],
  docsUrl: 'https://example.invalid',
};

const goodEvent = (externalId: string): DerivedEvent => ({
  externalId,
  timestamp: 1_700_000_000_000,
  kind: 'reward',
  origin: 'derived',
  legs: [
    {
      assetId: 'test:native',
      amount: '1',
      direction: 'in',
      venue: 'addr1',
      role: 'principal',
    },
  ],
});

/**
 * A module whose pages are keyed by the cursor they answer, which is how a
 * real provider behaves.
 *
 * Deliberately NOT keyed on a call counter: runConformance drains twice to
 * check idempotence, so a counter would have advanced by the second drain and
 * every well-behaved module would look non-idempotent.
 */
const moduleFrom = (
  pages: Map<string | null, { events: DerivedEvent[]; cursor: string | null }>,
): SourceModule => ({
  manifest,
  probe: async () => ({ ok: true }),
  fetchEvents: async (_config, cursor) => {
    const page = pages.get(cursor);
    if (!page) {
      throw new Error(`test helper has no page for cursor ${String(cursor)}`);
    }
    return page;
  },
});

const fixture = { config: { address: 'addr1' } };

describe('the conformance harness', () => {
  it('passes a module that paginates and then stops', async () => {
    const module = moduleFrom(
      new Map([
        [null, { events: [goodEvent('a')], cursor: 'page-2' }],
        ['page-2', { events: [goodEvent('b')], cursor: null }],
      ]),
    );
    await expect(runConformance(module, fixture)).resolves.toBeUndefined();
  });

  it('rejects a module that emits a duplicate externalId within one run', async () => {
    const module = moduleFrom(
      new Map([
        [null, { events: [goodEvent('dup'), goodEvent('dup')], cursor: null }],
      ]),
    );
    await expect(runConformance(module, fixture)).rejects.toThrow(
      /duplicate externalId/i,
    );
  });

  it('rejects an event with no legs', async () => {
    const bad = goodEvent('a');
    bad.legs = [];
    const module = moduleFrom(
      new Map([[null, { events: [bad], cursor: null }]]),
    );
    await expect(runConformance(module, fixture)).rejects.toThrow(
      /has no legs/i,
    );
  });

  it('rejects a module whose amounts are not decimal strings', async () => {
    const bad = goodEvent('a');
    bad.legs[0].amount = '1e6';
    const module = moduleFrom(
      new Map([[null, { events: [bad], cursor: null }]]),
    );
    await expect(runConformance(module, fixture)).rejects.toThrow(
      /invalid amount/i,
    );
  });

  it('rejects a module that emits a kind its manifest does not declare', async () => {
    const bad = goodEvent('a');
    bad.kind = 'fee';
    const module = moduleFrom(
      new Map([[null, { events: [bad], cursor: null }]]),
    );
    await expect(runConformance(module, fixture)).rejects.toThrow(
      /does not declare/i,
    );
  });

  it('rejects a module that never terminates', async () => {
    // Always answers with a fresh cursor, so pagination never ends.
    const module: SourceModule = {
      manifest,
      probe: async () => ({ ok: true }),
      fetchEvents: async () => ({
        events: [goodEvent(crypto.randomUUID())],
        cursor: 'always-more',
      }),
    };
    await expect(runConformance(module, fixture)).rejects.toThrow(
      /did not terminate/i,
    );
  });

  it('rejects a module that is not idempotent on a replayed cursor', async () => {
    // The host replays cursors after a partial sync. A module that returns
    // different externalIds for the same cursor breaks dedupe silently.
    let call = 0;
    const module: SourceModule = {
      manifest,
      probe: async () => ({ ok: true }),
      fetchEvents: async () => ({
        events: [goodEvent(`shifting-${call++}`)],
        cursor: null,
      }),
    };
    await expect(runConformance(module, fixture)).rejects.toThrow(
      /not idempotent/i,
    );
  });

  it('rejects a module that returns the same externalId with different content on replay', async () => {
    // The host upserts by (sourceId, externalId) alone and trusts the
    // payload - ids matching across a replay is not enough if the content
    // behind one of them silently changed.
    let call = 0;
    const module: SourceModule = {
      manifest,
      probe: async () => ({ ok: true }),
      fetchEvents: async () => {
        const event = goodEvent('stable-id');
        event.legs[0].amount = call === 0 ? '1' : '2';
        call += 1;
        return { events: [event], cursor: null };
      },
    };
    await expect(runConformance(module, fixture)).rejects.toThrow(
      /not idempotent/i,
    );
  });

  it('rejects a trade whose legs are all in the same direction', async () => {
    const bad = goodEvent('a');
    bad.kind = 'trade';
    bad.legs = [
      { ...bad.legs[0], direction: 'in', assetId: 'test:a' },
      { ...bad.legs[0], direction: 'in', assetId: 'test:b' },
    ];
    const module = moduleFrom(
      new Map([[null, { events: [bad], cursor: null }]]),
    );
    await expect(runConformance(module, fixture)).rejects.toThrow(
      /trade .* both an in and an out/i,
    );
  });
});
