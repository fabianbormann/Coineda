import { describe, it, expect, vi, afterEach } from 'vitest';
import en from '../src/translations/en.json';
import de from '../src/translations/de.json';
import { CARDANO_MESSAGES } from '@/sources/cardano/messages';
import cardanoYaci from '@/sources/cardano-yaci';
import cardanoBlockfrost from '@/sources/cardano-blockfrost';

const enKeys = new Set(Object.keys(en.translation));
const deKeys = new Set(Object.keys(de.translation));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Cardano probe messages', () => {
  it('has messages to check, so this gate is not vacuous', () => {
    expect(Object.keys(CARDANO_MESSAGES).length).toBeGreaterThan(0);
  });

  it.each(Object.entries(CARDANO_MESSAGES))(
    'keys %s in both locale files',
    (_name, message) => {
      // AddSourceDialog renders ProbeResult.message through t(), so a
      // message that is not a key ships the raw English string to a German
      // user. registry.test.ts covers field labels and help text but never
      // these, which is how two of them shipped untranslated.
      expect(enKeys).toContain(message);
      expect(deKeys).toContain(message);
    },
  );

  it('translates the interpolated host-shape message in both locales', () => {
    // It carries {{example}} because the example host is per provider -
    // suggesting a Yaci URL on a Blockfrost row sends the user to fix their
    // configuration with an address that cannot work.
    expect(CARDANO_MESSAGES.hostShape).toContain('{{example}}');
    for (const locale of [en, de] as const) {
      const translated = (locale.translation as Record<string, string>)[
        CARDANO_MESSAGES.hostShape
      ];
      expect(translated).toContain('{{example}}');
    }
  });

  it('keeps the locale files at equal size, so neither gains a key alone', () => {
    expect(enKeys).toEqual(deKeys);
  });

  it('names no address, key or host in any message', () => {
    // The module contract forbids putting config into a message: whatever a
    // module rejects with is stored as lastError and rendered on screen.
    for (const message of Object.values(CARDANO_MESSAGES)) {
      expect(message).not.toMatch(/addr1|addr_test1|stake1|stake_test1/);
      expect(message).not.toMatch(/https?:\/\//);
    }
  });
});

describe('every probe message that can reach the screen', () => {
  // CARDANO_MESSAGES is not the whole set: probeCardano also returns
  // provider.probeMessage(status), defined privately per provider module.
  // Those strings reach the same rendered message, and iterating the
  // constant alone cannot see them - the exact shape of the bug this file
  // was added to prevent, one level up. Driving the real probe() reaches
  // them through the code path that actually produces them, so this stays
  // honest when probeCardano is rewritten.
  const modules = [
    [
      'cardano-yaci',
      cardanoYaci,
      { baseUrl: 'https://y.example.org', address: 'addr1_x' },
    ],
    [
      'cardano-blockfrost',
      cardanoBlockfrost,
      {
        baseUrl: 'https://b.example.org',
        projectId: 'k',
        address: 'addr1_x',
      },
    ],
  ] as const;

  it.each(modules)(
    'is keyed in both locales: %s',
    async (_name, mod, config) => {
      const collected = new Set<string>();
      for (const status of [401, 403, 404, 429, 500, 503]) {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => new Response('{}', { status })),
        );
        const result = await mod.probe({ ...config });
        if (!result.ok && result.message) {
          collected.add(result.message);
        }
      }
      // A transport failure, which routes to probeMessage(0).
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('fetch failed');
        }),
      );
      const unreachable = await mod.probe({ ...config });
      if (!unreachable.ok && unreachable.message) {
        collected.add(unreachable.message);
      }

      expect(collected.size).toBeGreaterThan(0);
      for (const message of collected) {
        expect(enKeys, `missing from en.json: ${message}`).toContain(message);
        expect(deKeys, `missing from de.json: ${message}`).toContain(message);
      }
    },
  );
});
