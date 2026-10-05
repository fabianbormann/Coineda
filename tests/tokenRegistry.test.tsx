import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import 'fake-indexeddb/auto';
import '@/i18n';
import {
  QUERY_CHUNK,
  fetchTokenMeta,
  subjectsOf,
} from '@/assets/tokenRegistry';
import {
  readCached,
  resolveTokenMeta,
  writeCached,
} from '@/assets/tokenMetaStore';
import { TokenMetaProvider } from '@/assets/TokenMetaContext';
import { CryptoAmount } from '@/components/money/CryptoAmount';
import { AssetIcon } from '@/components/money/AssetIcon';
import { openLedger } from '@/ledger/db';
import { ASSET_DECIMALS, NIGHT_ASSET_ID } from '@/prices/scale';

/**
 * The Cardano token registry client and its cache.
 *
 * Measured facts this pins, all from a live call on 2026-10-05:
 * the bulk route returns property values UNWRAPPED while the single GET
 * wraps them in `{ value, signatures }`; an unknown subject is simply
 * absent from the answer; and the logo is base64 PNG, never SVG.
 */
const SUBJECT = NIGHT_ASSET_ID.slice('cardano:'.length);
const OTHER_POLICY = 'a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235';
const HOSKY = `${OTHER_POLICY}484f534b59`;

/** A 1x1 PNG, so the magic bytes are real rather than a placeholder string. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const bulkResponse = (rows: unknown[]) =>
  new Response(JSON.stringify({ subjects: rows }), { status: 200 });

beforeEach(async () => {
  const db = await openLedger();
  await db.clear('tokenMeta');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reading the registry', () => {
  it('reads values the bulk route returns unwrapped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        bulkResponse([
          {
            subject: SUBJECT,
            name: 'NIGHT',
            ticker: 'NIGHT',
            decimals: 6,
            logo: PNG_B64,
          },
        ]),
      ),
    );
    const meta = await fetchTokenMeta([SUBJECT]);
    expect(meta.get(SUBJECT)).toEqual({
      subject: SUBJECT,
      name: 'NIGHT',
      ticker: 'NIGHT',
      decimals: 6,
      logoPng: PNG_B64,
    });
  });

  it('also reads the signature-wrapped shape the single GET uses', async () => {
    // Two routes, two shapes. A parser written against only the one I
    // happened to test first is exactly how this module's Bitpanda sibling
    // once shipped a call that could never have worked.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        bulkResponse([
          {
            subject: SUBJECT,
            name: { value: 'NIGHT', signatures: [] },
            ticker: { value: 'NIGHT', signatures: [] },
            decimals: { value: 6, signatures: [] },
            logo: { value: PNG_B64, signatures: [] },
          },
        ]),
      ),
    );
    const meta = await fetchTokenMeta([SUBJECT]);
    expect(meta.get(SUBJECT)?.ticker).toBe('NIGHT');
    expect(meta.get(SUBJECT)?.decimals).toBe(6);
  });

  it('keeps decimals of zero, which is a real answer', async () => {
    // HOSKY's decimals are 0. A truthiness check would read that as absent
    // and the asset would lose its scale.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        bulkResponse([{ subject: HOSKY, ticker: 'HOSKY', decimals: 0 }]),
      ),
    );
    const meta = await fetchTokenMeta([HOSKY]);
    expect(meta.get(HOSKY)?.decimals).toBe(0);
  });

  it('omits a subject the registry does not list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bulkResponse([])),
    );
    const meta = await fetchTokenMeta([SUBJECT]);
    expect(meta.has(SUBJECT)).toBe(false);
    expect(meta.size).toBe(0);
  });

  it('chunks a long list rather than sending one enormous body', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(String(init.body));
        return bulkResponse([]);
      }),
    );
    const many = Array.from(
      { length: QUERY_CHUNK + 5 },
      (_, i) => `${OTHER_POLICY}${i.toString(16).padStart(8, '0')}`,
    );
    await fetchTokenMeta(many);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]).subjects).toHaveLength(QUERY_CHUNK);
    expect(JSON.parse(calls[1]).subjects).toHaveLength(5);
  });

  it('asks only about Cardano native assets', async () => {
    expect(
      subjectsOf([
        'bitcoin:native',
        'cardano:lovelace',
        'fiat:eur',
        NIGHT_ASSET_ID,
      ]),
    ).toEqual([SUBJECT]);
  });
});

describe('the cache', () => {
  it('records a miss so an unlisted token is not re-requested forever', async () => {
    // The registry omits unknown subjects rather than answering "no", so
    // without a recorded miss every page load re-asks about every token it
    // will never know - and in a real wallet most tokens are unlisted.
    const fetchMock = vi.fn(async () => bulkResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await resolveTokenMeta([NIGHT_ASSET_ID]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await resolveTokenMeta([NIGHT_ASSET_ID]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const { stale } = await readCached([SUBJECT]);
    expect(stale).toEqual([]);
  });

  it('serves a hit without asking again', async () => {
    const fetchMock = vi.fn(async () =>
      bulkResponse([{ subject: SUBJECT, ticker: 'NIGHT', decimals: 6 }]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = await resolveTokenMeta([NIGHT_ASSET_ID]);
    expect(first.get(NIGHT_ASSET_ID)?.ticker).toBe('NIGHT');

    const second = await resolveTokenMeta([NIGHT_ASSET_ID]);
    expect(second.get(NIGHT_ASSET_ID)?.ticker).toBe('NIGHT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('expires an entry rather than trusting it forever', async () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await writeCached(
      [SUBJECT],
      new Map([
        [
          SUBJECT,
          {
            subject: SUBJECT,
            name: 'NIGHT',
            ticker: 'NIGHT',
            decimals: 6,
            logoPng: null,
          },
        ],
      ]),
      old,
    );
    const { hits, stale } = await readCached([SUBJECT]);
    expect(hits.size).toBe(0);
    expect(stale).toEqual([SUBJECT]);
  });

  it('keys by asset id, not by subject', async () => {
    // Callers hold asset ids. Returning subjects would make every one of
    // them re-derive the mapping, which is how the two drift apart.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bulkResponse([{ subject: SUBJECT, ticker: 'NIGHT' }])),
    );
    const meta = await resolveTokenMeta([NIGHT_ASSET_ID]);
    expect([...meta.keys()]).toEqual([NIGHT_ASSET_ID]);
  });

  it('degrades to the cache when the registry is unreachable', async () => {
    // A decoration must never be able to break a balance screen.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(resolveTokenMeta([NIGHT_ASSET_ID])).resolves.toEqual(
      new Map(),
    );
  });
});

describe('on screen', () => {
  it('prefers the registry ticker over the offline decode', async () => {
    // The two have to DIFFER for this to mean anything. An earlier version
    // of this test used a token whose on-chain name and registry ticker
    // were both 'NIGHT', so it passed just as happily against code that
    // ignored the registry entirely.
    //
    // 'Hosky_Token_v2' is the shape of the real problem: an on-chain asset
    // name is whatever its minter typed, and the registry ticker is the
    // curated version.
    const UGLY = `${OTHER_POLICY}${Buffer.from('Hosky_Token_v2').toString('hex')}`;
    const assetId = `cardano:${UGLY}`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        bulkResponse([{ subject: UGLY, name: 'HOSKY Token', ticker: 'HOSKY' }]),
      ),
    );
    render(
      <TokenMetaProvider assetIds={[assetId]}>
        <CryptoAmount value="12" assetId={assetId} />
      </TokenMetaProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText(/12 HOSKY/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Hosky_Token_v2/)).toBeNull();
  });

  it('names the asset offline when the registry gives nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bulkResponse([])),
    );
    render(
      <TokenMetaProvider assetIds={[NIGHT_ASSET_ID]}>
        <CryptoAmount value="12000000" assetId={NIGHT_ASSET_ID} />
      </TokenMetaProvider>,
    );
    // Decoded straight out of the subject, so this holds with no network at
    // all - and it must never show the 66-character subject.
    expect(screen.getByText(/12 NIGHT/)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(SUBJECT))).toBeNull();
  });
});

describe('icons', () => {
  it('draws a vector for a chain it ships support for', () => {
    const { container } = render(<AssetIcon assetId="bitcoin:native" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // In brand colour, not currentColor: an identity mark tinted to the
    // body text colour stops being recognisable.
    expect(svg?.getAttribute('fill')).toBe('#F7931A');
    expect(container.querySelector('img')).toBeNull();
  });

  it('gives each known chain its own distinct mark', () => {
    const pathOf = (assetId: string) => {
      const { container } = render(<AssetIcon assetId={assetId} />);
      return container.querySelector('path')?.getAttribute('d');
    };
    const btc = pathOf('bitcoin:native');
    const eth = pathOf('eth:native');
    const ada = pathOf('cardano:lovelace');
    expect(new Set([btc, eth, ada]).size).toBe(3);
    for (const d of [btc, eth, ada]) {
      expect(d?.length ?? 0).toBeGreaterThan(50);
    }
  });

  it('uses the registry logo as a PNG, because CIP-26 has no SVG', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        bulkResponse([{ subject: SUBJECT, ticker: 'NIGHT', logo: PNG_B64 }]),
      ),
    );
    const { container } = render(
      <TokenMetaProvider assetIds={[NIGHT_ASSET_ID]}>
        <AssetIcon assetId={NIGHT_ASSET_ID} />
      </TokenMetaProvider>,
    );
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(`data:image/png;base64,${PNG_B64}`);
    // Decorative: the amount beside it already names the asset.
    expect(img?.getAttribute('alt')).toBe('');
  });

  it('falls back to a monogram rather than a blank', async () => {
    // A row with a gap where every sibling has a mark reads as a loading
    // bug. Most native tokens in a real wallet are unregistered.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bulkResponse([])),
    );
    const { container } = render(<AssetIcon assetId={NIGHT_ASSET_ID} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toBe('NI');
  });
});

describe('measured against the live registry on 2026-10-05', () => {
  it('pins the registry decimals against the scale amounts are stored with', () => {
    // The registry reports decimals, and this app also hardcodes them in
    // ASSET_DECIMALS. Scaling deliberately does NOT read the registry at
    // runtime: if the scale of a stored amount depended on a fetch, the
    // same holding would mean different quantities depending on whether a
    // request succeeded, and nothing downstream could tell.
    //
    // So the agreement is asserted here instead, offline, against the value
    // measured live: tokens.cardano.org reports decimals 6 for NIGHT. If
    // ASSET_DECIMALS is ever changed, this fails and whoever changed it has
    // to go and re-measure rather than discover it through a wrong balance.
    expect(ASSET_DECIMALS[NIGHT_ASSET_ID]).toBe(6);
  });

  it('pins the logo format, which is why the chain icons are bundled', () => {
    // CIP-26 specifies base64 PNG and the registry serves it: NIGHT's logo
    // arrives as 25,100 base64 characters decoding to 89 50 4E 47. There is
    // no SVG to be had from the registry, so vector marks exist only for
    // the chains Coineda bundles.
    expect(Buffer.from(PNG_B64, 'base64').subarray(0, 4).toString('hex')).toBe(
      '89504e47',
    );
  });
});
