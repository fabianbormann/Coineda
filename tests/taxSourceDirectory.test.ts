import { describe, it, expect } from 'vitest';
import { buildSourceDirectory, publicIdentities } from '@/tax/sourceDirectory';
import type { ManifestField } from '@/sources/types';
import type { LedgerEvent, SourceRecord } from '@/ledger/types';

const source = (overrides: Partial<SourceRecord> = {}): SourceRecord => ({
  id: 's1',
  moduleId: 'kraken-csv',
  label: 'Kraken',
  // A real config holds credentials. Every test below runs with one
  // present, so "never reaches the page" is asserted against the shape
  // that would actually leak rather than an empty object.
  config: { apiKey: 'cg-secret-value' },
  ...overrides,
});

const eventFrom = (
  sourceId: string,
  venue: string,
  timestamp = Date.UTC(2025, 0, 1),
): LedgerEvent => ({
  id: `${sourceId}-${venue}-${timestamp}`,
  sourceId,
  externalId: `${venue}-${timestamp}`,
  timestamp,
  kind: 'trade',
  origin: 'derived',
  legs: [
    {
      assetId: 'cardano:lovelace',
      amount: '10',
      direction: 'in',
      venue,
      role: 'principal',
    },
  ],
});

describe('buildSourceDirectory', () => {
  it('lists each source with the venues its events actually used', () => {
    const entries = buildSourceDirectory(
      [source()],
      [
        eventFrom('s1', 'spot / main'),
        eventFrom('s1', 'spot / main', Date.UTC(2025, 1, 1)),
        eventFrom('s1', 'staking', Date.UTC(2025, 2, 1)),
      ],
      () => undefined,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe('Kraken');
    expect(entries[0].moduleId).toBe('kraken-csv');
    expect(entries[0].venues).toEqual(['spot / main', 'staking']);
    expect(entries[0].eventCount).toBe(3);
  });

  it('reports the span its events cover', () => {
    const entries = buildSourceDirectory(
      [source()],
      [
        eventFrom('s1', 'spot / main', Date.UTC(2025, 5, 1)),
        eventFrom('s1', 'spot / main', Date.UTC(2023, 0, 1)),
        eventFrom('s1', 'spot / main', Date.UTC(2024, 0, 1)),
      ],
      () => undefined,
    );

    expect(entries[0].firstAt).toBe(Date.UTC(2023, 0, 1));
    expect(entries[0].lastAt).toBe(Date.UTC(2025, 5, 1));
  });

  it('never exposes a source config value', () => {
    // SourceRecord.config is documented as possibly holding secrets, and
    // this directory is printed. The whole entry is serialised rather than
    // checking a named field, so a future field that happens to carry
    // config through is caught too.
    const entries = buildSourceDirectory(
      [source()],
      [eventFrom('s1', 'spot')],
      () => undefined,
    );

    expect(JSON.stringify(entries)).not.toContain('cg-secret-value');
    expect(JSON.stringify(entries)).not.toContain('apiKey');
  });

  it('groups events whose source no longer exists rather than dropping them', () => {
    // deleteSourceCascade removes the record, and a restored checkpoint can
    // carry events ahead of their sources. Either way the figures above the
    // directory were computed FROM these events, so a directory that
    // omitted them would understate what the report was built on - which is
    // worse than naming an orphan.
    const entries = buildSourceDirectory(
      [],
      [eventFrom('deleted-source', 'wallet-a')],
      () => undefined,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].sourceId).toBeNull();
    expect(entries[0].moduleId).toBeNull();
    expect(entries[0].venues).toEqual(['wallet-a']);
  });

  it('puts the orphan group last, after every configured source', () => {
    const entries = buildSourceDirectory(
      [source()],
      [eventFrom('s1', 'spot'), eventFrom('gone', 'wallet-a')],
      () => undefined,
    );

    expect(entries.map((entry) => entry.sourceId)).toEqual(['s1', null]);
  });

  it('lists a configured source that has produced nothing yet', () => {
    // A source added but never synced is still part of what the report
    // covers - and its absence from the directory would read as "this
    // wallet was not included", which is a different and alarming claim.
    const entries = buildSourceDirectory([source()], [], () => undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0].eventCount).toBe(0);
    expect(entries[0].venues).toEqual([]);
    expect(entries[0].firstAt).toBeUndefined();
  });
});

const field = (name: string, type: ManifestField['type']): ManifestField => ({
  name,
  label: name,
  type,
  help: name,
});

describe('publicIdentities', () => {
  const fields = [
    field('baseUrl', 'text'),
    field('projectId', 'text'),
    field('xpub', 'text'),
    field('address', 'address'),
    field('more', 'addressList'),
    field('apiKey', 'apiKey'),
    field('secret', 'secret'),
  ];
  const config = {
    baseUrl: 'https://node.example',
    projectId: 'proj-secret',
    xpub: 'xpub6abc',
    address: 'addr1abc',
    more: 'addr1x\n\n  addr1y  \n',
    apiKey: 'key-secret',
    secret: 'sec-secret',
  };

  it('keeps only addresses, address lists and an xpub', () => {
    expect(publicIdentities(config, fields)).toEqual([
      'xpub6abc',
      'addr1abc',
      'addr1x',
      'addr1y',
    ]);
  });

  it('yields nothing without a field list', () => {
    expect(publicIdentities(config, undefined)).toEqual([]);
  });

  it('carries identities on directory entries, none on orphans', () => {
    const entries = buildSourceDirectory(
      [source({ moduleId: 'm', config })],
      [eventFrom('s1', 'v'), eventFrom('gone', 'v')],
      (id) => (id === 'm' ? fields : undefined),
    );
    expect(entries[0].identities).toContain('addr1abc');
    expect(JSON.stringify(entries)).not.toContain('secret');
    expect(entries[1].identities).toEqual([]);
  });
});
