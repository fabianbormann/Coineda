import { isValidAmount } from '@/ledger/amount';
import type { DerivedEvent, SourceModule } from './types';

export type ConformanceFixture = {
  config: Record<string, string>;
};

/** A module that keeps returning a non-null cursor forever would hang a sync.
 *  Exported so the live sync driver (src/sync/syncSource.ts) caps its own
 *  page loop at the exact same bound a module was conformance-tested against. */
export const MAX_PAGES = 50;

const checkEvent = (event: DerivedEvent, module: SourceModule): void => {
  if (!module.manifest.emits.includes(event.kind)) {
    throw new Error(
      `${module.manifest.id}: emitted kind '${event.kind}' but its manifest does not declare it`,
    );
  }
  if (event.legs.length === 0) {
    throw new Error(`${module.manifest.id}: ${event.externalId} has no legs`);
  }
  for (const leg of event.legs) {
    if (!isValidAmount(leg.amount)) {
      throw new Error(
        `${module.manifest.id}: invalid amount ${JSON.stringify(leg.amount)} on ${event.externalId}`,
      );
    }
  }
  if (!Number.isFinite(event.timestamp) || event.timestamp <= 0) {
    throw new Error(
      `${module.manifest.id}: ${event.externalId} has a non-finite timestamp`,
    );
  }
  if (event.origin !== 'derived') {
    throw new Error(
      `${module.manifest.id}: ${event.externalId} must be origin 'derived'`,
    );
  }
  if (event.kind === 'trade') {
    const directions = new Set(
      event.legs.filter((l) => l.role === 'principal').map((l) => l.direction),
    );
    if (!directions.has('in') || !directions.has('out')) {
      throw new Error(
        `${module.manifest.id}: trade ${event.externalId} needs both an in and an out principal leg`,
      );
    }
  }
};

const drain = async (
  module: SourceModule,
  fixture: ConformanceFixture,
): Promise<DerivedEvent[]> => {
  const collected: DerivedEvent[] = [];
  const seen = new Set<string>();
  let cursor = null as string | null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await module.fetchEvents(fixture.config, cursor);
    for (const event of result.events) {
      checkEvent(event, module);
      if (seen.has(event.externalId)) {
        throw new Error(
          `${module.manifest.id}: emitted duplicate externalId '${event.externalId}' in one run`,
        );
      }
      seen.add(event.externalId);
      collected.push(event);
    }
    if (result.cursor === null) {
      return collected;
    }
    cursor = result.cursor;
  }

  throw new Error(
    `${module.manifest.id}: did not terminate within ${MAX_PAGES} pages`,
  );
};

/**
 * A content fingerprint for one event, keyed separately by externalId.
 *
 * Two drains agreeing on the set of externalIds is not enough: a module that
 * returns the same ids but a different amount, kind or timestamp on replay
 * would upsert silently-wrong data into storage on every re-sync, because the
 * host's putEvents keys on (sourceId, externalId) alone and trusts the
 * payload. Comparing this fingerprint is what catches that.
 */
const fingerprint = (event: DerivedEvent): string =>
  JSON.stringify({
    kind: event.kind,
    timestamp: event.timestamp,
    legs: event.legs,
  });

/**
 * The merge gate every source module must pass.
 *
 * Checks the properties the host depends on and cannot verify at runtime:
 * events match the declared manifest, amounts are decimal strings, trades
 * balance directionally, pagination terminates, externalIds are unique within
 * a run, and - the one that matters most - replaying from the start yields
 * the same externalIds AND the same content for each, because the host
 * replays cursors after a partial sync, dedupes on
 * [sourceId, externalId], and upserts whatever the module returns.
 *
 * Throws with a specific message, naming the module, on the first violation.
 * A module that passes is mergeable whoever or whatever wrote it.
 */
export const runConformance = async (
  module: SourceModule,
  fixture: ConformanceFixture,
): Promise<void> => {
  const first = await drain(module, fixture);
  const second = await drain(module, fixture);

  const idsOf = (events: DerivedEvent[]) =>
    events.map((event) => event.externalId).sort();

  if (JSON.stringify(idsOf(first)) !== JSON.stringify(idsOf(second))) {
    throw new Error(
      `${module.manifest.id} is not idempotent: a replayed run produced different externalIds`,
    );
  }

  const fingerprintsOf = (events: DerivedEvent[]) =>
    new Map(events.map((event) => [event.externalId, fingerprint(event)]));
  const firstFingerprints = fingerprintsOf(first);
  const secondFingerprints = fingerprintsOf(second);

  for (const [externalId, firstFingerprint] of firstFingerprints) {
    if (secondFingerprints.get(externalId) !== firstFingerprint) {
      throw new Error(
        `${module.manifest.id} is not idempotent: a replayed run produced different data for externalId '${externalId}'`,
      );
    }
  }
};
