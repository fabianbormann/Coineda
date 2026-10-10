import { describe, expect, it } from 'vitest';
import {
  canonicalEvent,
  fingerprintLedger,
  shortFingerprint,
} from '@/ledger/fingerprint';
import type { ManualTransferLink } from '@/ledger/manualLinks';
import type { LedgerEvent } from '@/ledger/types';

const event = (over: Partial<LedgerEvent> = {}): LedgerEvent => ({
  id: 'a',
  sourceId: 's1',
  externalId: 'x1',
  timestamp: 1000,
  kind: 'trade',
  origin: 'derived',
  legs: [
    {
      assetId: 'btc',
      amount: '1',
      direction: 'in',
      venue: 'v',
      role: 'principal',
    },
  ],
  ...over,
});

const fp = (events: LedgerEvent[], links: ManualTransferLink[] = []) =>
  fingerprintLedger({ events, links });

describe('fingerprintLedger', () => {
  it('ignores order, id, sourceId and raw', async () => {
    const a = event();
    const b = event({ externalId: 'x2', timestamp: 2000 });
    const left = await fp([a, b]);
    const right = await fp([
      { ...b, id: 'q', sourceId: 'other', raw: { z: 1 } } as LedgerEvent,
      { ...a, id: 'r', sourceId: 'else', raw: 'junk' } as LedgerEvent,
    ]);
    expect(left).toBe(right);
  });

  it('changes when one leg amount changes', async () => {
    const base = event();
    const changed = event({
      legs: [{ ...base.legs[0], amount: '1.1' }],
    });
    expect(await fp([base])).not.toBe(await fp([changed]));
  });

  it('is 64 lowercase hex characters', async () => {
    expect(await fp([event()])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pins the empty list to the SHA-256 of {"events":[],"links":[]}', async () => {
    expect(await fp([])).toBe(
      '987ed8d5b6569311d47c90eb3dbd6f301ebfe76a7eceee9ef315036d1a723776',
    );
  });

  it('drops the excluded keys and sorts the rest', () => {
    const canonical = canonicalEvent({
      ...event(),
      raw: { a: 1 },
    } as LedgerEvent);
    expect(Object.keys(canonical)).toEqual([...Object.keys(canonical)].sort());
    expect(canonical).not.toHaveProperty('id');
    expect(canonical).not.toHaveProperty('sourceId');
    expect(canonical).not.toHaveProperty('raw');
  });

  it('orders events that tie on externalId, timestamp and kind by content', async () => {
    const a = event({ legs: [{ ...event().legs[0], amount: '1' }] });
    const b = event({
      legs: [{ ...event().legs[0], amount: '2' }],
      sourceId: 's2',
    });
    expect(await fp([a, b])).toBe(await fp([b, a]));
  });

  it('covers manual links, in any order', async () => {
    const l1: ManualTransferLink = {
      sourceId: 's',
      externalId: '1',
      txHash: 'h1',
      confirmedAt: 1,
    };
    const l2: ManualTransferLink = {
      sourceId: 's',
      externalId: '2',
      txHash: 'h2',
      confirmedAt: 2,
    };
    expect(await fp([event()], [l1, l2])).toBe(await fp([event()], [l2, l1]));
    expect(await fp([event()], [l1])).not.toBe(await fp([event()]));
  });

  it('shortens to 12 characters', () => {
    expect(shortFingerprint('a'.repeat(64))).toHaveLength(12);
  });
});
