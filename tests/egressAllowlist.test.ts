import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PUBLIC_ENDPOINTS } from '@/config/endpoints';
import {
  allowHosts,
  guardFetch,
  resetAllowedHosts,
  UnexpectedEgressError,
} from './helpers/egress';

/**
 * The static egress gate.
 *
 * Every `http(s)://` literal in `src/**\/*.ts(x)` - code, strings and
 * comments alike, since telling them apart reliably would need a parser -
 * must either point at a host in `PUBLIC_ENDPOINTS` (the single list of
 * outbound hosts, which an operator overrides) or be named below as a link
 * the app only SHOWS: a manifest `docsUrl`, a field's help text, the
 * footer, a comment citing a provider. A new outbound host therefore fails
 * this test until it is added to `endpoints.ts`, where the operator's
 * configuration and restricted mode can see it.
 *
 * `src/translations` is excluded: it is JSON, and its keys are the English
 * copy, not code paths.
 */

/** Hosts whose every link is documentation, never fetched. */
const DOC_HOSTS = new Set([
  // Footer (release notes, licence), Esplora/Blockscout source links in
  // comments, the mapped-CSV docs link.
  'github.com',
]);

/** Exact literals that are shown or cited, never fetched. */
const DOC_URLS = new Set([
  // SVG namespace in ChainIcons: an XML identifier, not a request.
  'http://www.w3.org/2000/svg',
  // Frankfurter's homepage, cited in ecb.ts (the API is api.frankfurter.dev).
  'https://frankfurter.dev',
  // Manifest docsUrl values.
  'https://www.binance.com/en/support/faq/how-to-check-transaction-records-360002058352',
  'https://developers.bitpanda.com',
  'https://blockfrost.dev',
  'https://store.yaci.xyz',
  'https://help.coinbase.com/en/coinbase/taxes-reports-and-financial-services/taxes/transaction-history',
  'https://docs.blockscout.com/devs/apis/rest',
  'https://support.kraken.com/articles/360001169383-how-to-export-ledgers',
  'https://support.ledger.com/article/360014094879-zd',
  // Provider homepages cited in module comments.
  'https://www.bitpanda.com',
  'https://blockfrost.io',
  // Test networks named in the Blockfrost base-URL help text. The user may
  // type them; the app's own default stays the configured mainnet host.
  'https://cardano-preprod.blockfrost.io',
  'https://cardano-preview.blockfrost.io',
  // Network templates in the Blockfrost/Yaci module comments.
  'https://cardano-{mainnet,preprod,preview}.blockfrost.io',
  'https://yaci-store.{mainnet,preprod,preview}.colo2.cf-systems.org',
  // Placeholders in the trailing-slash comment in sources/http.ts.
  'https://host/',
  'https://host//api/v1/',
]);

const ENDPOINT_HOSTS = new Set(
  Object.values(PUBLIC_ENDPOINTS).map((url) => new URL(url).host),
);

const LITERAL = /https?:\/\/[^\s'"`<>()\]]+/g;

/** The `http(s)://` literals in `text` that are neither a public endpoint's
 *  host nor allow-listed documentation. */
const unexpectedLiterals = (text: string): string[] => {
  const found: string[] = [];
  for (const match of text.matchAll(LITERAL)) {
    const literal = match[0].replace(/[.,;:]+$/, '');
    if (DOC_URLS.has(literal)) {
      continue;
    }
    const host = /^https?:\/\/([^/?#]+)/.exec(literal)?.[1] ?? '';
    if (ENDPOINT_HOSTS.has(host) || DOC_HOSTS.has(host)) {
      continue;
    }
    found.push(literal);
  }
  return found;
};

const SRC = path.resolve(__dirname, '../src');

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return full === path.join(SRC, 'translations') ? [] : sourceFiles(full);
    }
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

describe('the static egress gate', () => {
  it('finds source files to scan', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(50);
  });

  it('allows only the public endpoints and named documentation links in src', () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      unexpectedLiterals(fs.readFileSync(file, 'utf8')).map(
        (literal) => `${path.relative(SRC, file)}: ${literal}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('flags an unknown host', () => {
    const text = `const url = 'https://unexpected.example/api';\n// see https://github.com/x`;
    expect(unexpectedLiterals(text)).toEqual([
      'https://unexpected.example/api',
    ]);
  });

  it('accepts a public endpoint host on any route', () => {
    expect(
      unexpectedLiterals('`https://coins.llama.fi/batchHistorical?coins=`'),
    ).toEqual([]);
  });
});

describe('the runtime egress guard', () => {
  afterEach(() => {
    resetAllowedHosts();
  });

  it('rejects a request to a host no test allowed', async () => {
    const attempt = fetch('https://unexpected.example/prices');
    await expect(attempt).rejects.toBeInstanceOf(UnexpectedEgressError);
    await expect(
      fetch('https://unexpected.example/prices'),
    ).rejects.toMatchObject({ host: 'unexpected.example' });
  });

  it('passes an allowed host on to the original fetch', async () => {
    const original = vi.fn(async () => new Response('ok'));
    const guarded = guardFetch(original as unknown as typeof fetch);
    allowHosts('mirror.internal:8443');
    const response = await guarded('https://mirror.internal:8443/prices');
    expect(await response.text()).toBe('ok');
    expect(original).toHaveBeenCalledTimes(1);
    // Port is part of the host: the same name on another port is refused.
    await expect(
      guarded('https://mirror.internal/prices'),
    ).rejects.toBeInstanceOf(UnexpectedEgressError);
  });

  it('lets non-http schemes through', async () => {
    const response = await fetch('data:text/plain,hello');
    expect(await response.text()).toBe('hello');
  });
});
