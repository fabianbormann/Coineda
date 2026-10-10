import { describe, expect, it } from 'vitest';
import {
  canonicalEvent,
  fingerprintEvents,
  shortFingerprint,
} from '@/ledger/fingerprint';
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

describe('fingerprintEvents', () => {
  it('ignores order, id, sourceId and raw', async () => {
    const a = event();
    const b = event({ externalId: 'x2', timestamp: 2000 });
    const left = await fingerprintEvents([a, b]);
    const right = await fingerprintEvents([
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
    expect(await fingerprintEvents([base])).not.toBe(
      await fingerprintEvents([changed]),
    );
  });

  it('is 64 lowercase hex characters', async () => {
    expect(await fingerprintEvents([event()])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pins the empty list to the SHA-256 of "[]"', async () => {
    expect(await fingerprintEvents([])).toBe(
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
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

  it('shortens to 12 characters', () => {
    expect(shortFingerprint('a'.repeat(64))).toHaveLength(12);
  });
});
