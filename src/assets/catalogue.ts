import { NIGHT_ASSET_ID, USDC_ASSET_ID, USDT_ASSET_ID } from './ids';

export type AssetKind = 'native' | 'token' | 'fiat';

export type AssetEntry = {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  chain: string;
  kind: AssetKind;
  coingeckoId?: string;
  aliases?: string[];
  verified: { source: string; checkedOn: string };
};

/**
 * The one list of assets Coineda can scale and price. ASSET_DECIMALS
 * (src/prices/scale.ts) and COINGECKO_IDS (src/prices/coingecko.ts) are
 * derived views of it.
 *
 * Every row carries its provenance. CHECKED_ON is the day the CoinGecko
 * `/coins/list` ids and symbols were compared, and, for tokens, the day
 * `/coins/<id>` was read for `platforms.ethereum` (contract) and
 * `detail_platforms.ethereum.decimal_place`. A native coin's decimals are the
 * chain's own base unit (8 for satoshis, 18 for wei, ...), which CoinGecko
 * does not publish for a chain's native coin, so those rows cite the chain.
 *
 * A symbol is not an identity (see NIGHT_ASSET_ID): resolveSymbol answers
 * only where exactly one entry carries the symbol.
 */
const CHECKED_ON = '2026-10-10';
const NATIVE_SOURCE = 'CoinGecko /coins/list + chain docs';
const TOKEN_SOURCE = 'CoinGecko /coins/list + /coins/<id> detail_platforms';

const native = (
  id: string,
  symbol: string,
  name: string,
  decimals: number,
  chain: string,
  coingeckoId: string,
  aliases?: string[],
): AssetEntry => ({
  id,
  symbol,
  name,
  decimals,
  chain,
  kind: 'native',
  coingeckoId,
  ...(aliases ? { aliases } : {}),
  verified: { source: NATIVE_SOURCE, checkedOn: CHECKED_ON },
});

const ethToken = (
  address: string,
  symbol: string,
  name: string,
  decimals: number,
  coingeckoId: string,
  source: string = TOKEN_SOURCE,
): AssetEntry => ({
  id: `eth:${address}`,
  symbol,
  name,
  decimals,
  chain: 'eth',
  kind: 'token',
  coingeckoId,
  verified: { source, checkedOn: CHECKED_ON },
});

const fiat = (iso: string, name: string, decimals: number): AssetEntry => ({
  id: `fiat:${iso.toLowerCase()}`,
  symbol: iso,
  name,
  decimals,
  chain: 'fiat',
  kind: 'fiat',
  verified: { source: 'ISO 4217 minor units', checkedOn: CHECKED_ON },
});

const ENTRIES: AssetEntry[] = [
  native('bitcoin:native', 'BTC', 'Bitcoin', 8, 'bitcoin', 'bitcoin'),
  native('eth:native', 'ETH', 'Ether', 18, 'eth', 'ethereum'),
  native('cardano:lovelace', 'ADA', 'Cardano', 6, 'cardano', 'cardano'),
  native('solana:native', 'SOL', 'Solana', 9, 'solana', 'solana'),
  native('polkadot:native', 'DOT', 'Polkadot', 10, 'polkadot', 'polkadot'),
  native('xrp:native', 'XRP', 'XRP', 6, 'xrp', 'ripple'),
  native('litecoin:native', 'LTC', 'Litecoin', 8, 'litecoin', 'litecoin'),
  native('dogecoin:native', 'DOGE', 'Dogecoin', 8, 'dogecoin', 'dogecoin'),
  native(
    'bitcoin-cash:native',
    'BCH',
    'Bitcoin Cash',
    8,
    'bitcoin-cash',
    'bitcoin-cash',
  ),
  native('stellar:native', 'XLM', 'Stellar', 7, 'stellar', 'stellar'),
  native('tron:native', 'TRX', 'TRON', 6, 'tron', 'tron'),
  native('cosmos:native', 'ATOM', 'Cosmos', 6, 'cosmos', 'cosmos'),
  native(
    'avalanche:native',
    'AVAX',
    'Avalanche',
    18,
    'avalanche',
    'avalanche-2',
  ),
  native('bnb:native', 'BNB', 'BNB', 18, 'bnb', 'binancecoin'),
  native('near:native', 'NEAR', 'NEAR Protocol', 24, 'near', 'near'),
  native('algorand:native', 'ALGO', 'Algorand', 6, 'algorand', 'algorand'),
  native('tezos:native', 'XTZ', 'Tezos', 6, 'tezos', 'tezos'),
  native('monero:native', 'XMR', 'Monero', 12, 'monero', 'monero'),
  native(
    'ethereum-classic:native',
    'ETC',
    'Ethereum Classic',
    18,
    'ethereum-classic',
    'ethereum-classic',
  ),
  native(
    'polygon:native',
    'POL',
    'POL (ex MATIC)',
    18,
    'polygon',
    'polygon-ecosystem-token',
    ['MATIC'],
  ),
  native('kusama:native', 'KSM', 'Kusama', 12, 'kusama', 'kusama'),
  native('filecoin:native', 'FIL', 'Filecoin', 18, 'filecoin', 'filecoin'),
  native('eos:native', 'EOS', 'EOS', 4, 'eos', 'eos'),
  native('hedera:native', 'HBAR', 'Hedera', 8, 'hedera', 'hedera-hashgraph'),
  native(
    'internet-computer:native',
    'ICP',
    'Internet Computer',
    8,
    'internet-computer',
    'internet-computer',
  ),
  native('vechain:native', 'VET', 'VeChain', 18, 'vechain', 'vechain'),
  native('sui:native', 'SUI', 'Sui', 9, 'sui', 'sui'),
  native('aptos:native', 'APT', 'Aptos', 8, 'aptos', 'aptos'),
  // CoinGecko has since relabelled this coin's ticker GRAM; the id is
  // unchanged and the market still calls it TON, so TON stays the symbol.
  native('ton:native', 'TON', 'Toncoin', 9, 'ton', 'the-open-network', [
    'GRAM',
  ]),
  {
    ...ethToken(USDT_ASSET_ID.slice(4), 'USDT', 'Tether', 6, 'tether'),
    id: USDT_ASSET_ID,
  },
  {
    ...ethToken(USDC_ASSET_ID.slice(4), 'USDC', 'USD Coin', 6, 'usd-coin'),
    id: USDC_ASSET_ID,
  },
  ethToken(
    '0x6b175474e89094c44da98b954eedeac495271d0f',
    'DAI',
    'Dai',
    18,
    'dai',
  ),
  ethToken(
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    'WBTC',
    'Wrapped Bitcoin',
    8,
    'wrapped-bitcoin',
  ),
  ethToken(
    '0x514910771af9ca656af840dff83e8264ecf986ca',
    'LINK',
    'Chainlink',
    18,
    'chainlink',
  ),
  ethToken(
    '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
    'UNI',
    'Uniswap',
    18,
    'uniswap',
  ),
  ethToken(
    '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9',
    'AAVE',
    'Aave',
    18,
    'aave',
  ),
  ethToken(
    '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2',
    'MKR',
    'Maker',
    18,
    'maker',
  ),
  ethToken(
    '0xc944e90c64b2c07662a292be6244bdf05cda44a7',
    'GRT',
    'The Graph',
    18,
    'the-graph',
  ),
  ethToken(
    '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce',
    'SHIB',
    'Shiba Inu',
    18,
    'shiba-inu',
  ),
  ethToken(
    '0x6982508145454ce325ddbe47a25d4ec3d2311933',
    'PEPE',
    'Pepe',
    18,
    'pepe',
  ),
  ethToken(
    '0x5a98fcbea516cf06857215779fd812ca3bef1b32',
    'LDO',
    'Lido DAO',
    18,
    'lido-dao',
  ),
  ethToken(
    '0xc18360217d8f7ab5e7c516566761ea12ce7f9d72',
    'ENS',
    'Ethereum Name Service',
    18,
    'ethereum-name-service',
  ),
  ethToken(
    '0xd533a949740bb3306d119cc777fa900ba034cd52',
    'CRV',
    'Curve DAO',
    18,
    'curve-dao-token',
  ),
  ethToken(
    '0xc00e94cb662c3520282e6f5717214004a7f26888',
    'COMP',
    'Compound',
    18,
    'compound-governance-token',
  ),
  ethToken(
    '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f',
    'SNX',
    'Synthetix',
    18,
    'havven',
  ),
  // CoinGecko's matic-network no longer lists any platform (it is flagged
  // "migrated to POL"), so contract and decimals were read from Ethereum
  // Blockscout instead. It is priced as POL (the migration is 1:1), because
  // the matic-network feed is thin and stale.
  ethToken(
    '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0',
    'MATIC',
    'Polygon (MATIC, ERC-20)',
    18,
    'polygon-ecosystem-token',
    'contract and decimals via Ethereum Blockscout; priced as POL (1:1 migration), CoinGecko polygon-ecosystem-token',
  ),
  ethToken(
    '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
    'stETH',
    'Lido Staked Ether',
    18,
    'staked-ether',
  ),
  {
    id: NIGHT_ASSET_ID,
    symbol: 'NIGHT',
    name: 'Midnight',
    decimals: 6,
    chain: 'cardano',
    kind: 'token',
    coingeckoId: 'midnight-3',
    verified: { source: TOKEN_SOURCE, checkedOn: CHECKED_ON },
  },
  fiat('EUR', 'Euro', 2),
  fiat('USD', 'US Dollar', 2),
  fiat('GBP', 'Pound Sterling', 2),
  fiat('CHF', 'Swiss Franc', 2),
  fiat('JPY', 'Japanese Yen', 0),
  fiat('CAD', 'Canadian Dollar', 2),
  fiat('AUD', 'Australian Dollar', 2),
];

export const ASSET_CATALOGUE: ReadonlyArray<Readonly<AssetEntry>> =
  Object.freeze(ENTRIES.map((e) => Object.freeze(e)));

const BY_ID = new Map(ASSET_CATALOGUE.map((e) => [e.id, e]));

export const assetById = (id: string): AssetEntry | undefined => BY_ID.get(id);

const namesOf = (e: AssetEntry): string[] =>
  [e.symbol, ...(e.aliases ?? [])].map((s) => s.toUpperCase());

/** Every entry carrying this symbol or alias - the candidates behind an
 *  ambiguous answer from `resolveSymbol`. */
export const entriesFor = (symbol: string): AssetEntry[] => {
  const wanted = symbol.toUpperCase();
  return ASSET_CATALOGUE.filter((e) => namesOf(e).includes(wanted));
};

/**
 * The entry for a ticker, or undefined when the ticker is unknown or
 * ambiguous. With a `chain` hint only an entry on that chain may be
 * returned, even when the ticker is otherwise unique: USDT hinted 'tron' is
 * not the Ethereum USDT. Anything not exactly one is undefined, not a guess.
 */
export const resolveSymbol = (
  symbol: string,
  hint?: { chain?: string },
): AssetEntry | undefined => {
  const found = entriesFor(symbol);
  if (hint?.chain) {
    const onChain = found.filter((e) => e.chain === hint.chain);
    return onChain.length === 1 ? onChain[0] : undefined;
  }
  return found.length === 1 ? found[0] : undefined;
};

/** Upper-cased symbols and aliases carried by more than one entry. */
export const ambiguousSymbols = (): string[] => {
  const counts = new Map<string, number>();
  for (const e of ASSET_CATALOGUE) {
    for (const name of new Set(namesOf(e))) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts].filter(([, n]) => n > 1).map(([name]) => name);
};
