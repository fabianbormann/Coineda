# Changelog

## [0.3.1](https://github.com/fabianbormann/Coineda/compare/v0.3.0...v0.3.1) (2026-10-11)


### Bug Fixes

* **money:** never show a non-zero crypto amount below eight decimals as 0 ([da87722](https://github.com/fabianbormann/Coineda/commit/da87722465411d4f5bd28e88b33d73d35814a4b4))
* **prices:** price a cached day again when its source was never recorded ([cd4e0ee](https://github.com/fabianbormann/Coineda/commit/cd4e0eea41d7219981ea734154e042dca8b2b9b8))

## [0.3.0](https://github.com/fabianbormann/Coineda/compare/v0.2.12...v0.3.0) (2026-10-11)


### Features

* **a11y:** follow the chosen language, name each page, add a skip link and move focus on navigation ([9ab19a9](https://github.com/fabianbormann/Coineda/commit/9ab19a9a1d2a9ec40e50b6b60d6bc1ec026609c9))
* **a11y:** honour reduced motion, announce the balance, and make the journey video pausable ([8969ca9](https://github.com/fabianbormann/Coineda/commit/8969ca9d114c3a6a27a49520e07d184c17b602c9))
* **a11y:** measure token contrast in both themes and adjust the tokens that failed ([2f93c4c](https://github.com/fabianbormann/Coineda/commit/2f93c4c6db4222fff219a8330b4694a1ace627ed))
* **assets:** add an asset catalogue with provenance and derive decimals and price ids from it ([ff7d479](https://github.com/fabianbormann/Coineda/commit/ff7d479f55a059fec115899c76ce269749907af3))
* **carf:** aggregate the ledger per asset and CARF category ([0c66132](https://github.com/fabianbormann/Coineda/commit/0c6613205567615730dc3f8d03f0cf64ed996cd5))
* **carf:** compare the reported figures with the ledger and export the result ([0ddeb1d](https://github.com/fabianbormann/Coineda/commit/0ddeb1d436c19ae6d00a01533041561bbd186213))
* **carf:** parse the OECD CARF XML message a provider reports to the BZSt ([57c555d](https://github.com/fabianbormann/Coineda/commit/57c555d039f4efb9c14abf4604b1ada4980dbb21))
* **carf:** recognise reported crypto-asset names and propose the matching sources ([f7d3981](https://github.com/fabianbormann/Coineda/commit/f7d398178b2b5340d1990ccda874463d668ec27c))
* **carf:** reconcile a provider's CARF report with the ledger on the tax report screen ([bf3ee00](https://github.com/fabianbormann/Coineda/commit/bf3ee00809e5f5048b76882f007f930e03cffeb8))
* **clients:** keep a registry of client ledgers on the device ([9bc52b8](https://github.com/fabianbormann/Coineda/commit/9bc52b829fb768b1e347c6b5ed5684cfebb9488b))
* **clients:** switch clients from the header and remount the app per client ([2b9203a](https://github.com/fabianbormann/Coineda/commit/2b9203abd2a6985541b710e5c338fa69f6151db5))
* **config:** add a restricted egress mode that stays on the operator's hosts ([febd598](https://github.com/fabianbormann/Coineda/commit/febd598b36f208d4c6fbbe1f531e3775f7480428))
* **config:** route every outbound host through one endpoint configuration ([3a8693e](https://github.com/fabianbormann/Coineda/commit/3a8693e35f2be23012836bd6409e243e27cff167))
* **csv:** sniff the delimiter and normalise decimal commas ([6dbbc9f](https://github.com/fabianbormann/Coineda/commit/6dbbc9ff4f83bae3db49f8a2b9e86f03c46c0d69))
* **datev:** build a Buchungsstapel from the German report ([e1446ac](https://github.com/fabianbormann/Coineda/commit/e1446acdb23d57949fc7e19c052ceb6a4a2568e8))
* **datev:** collect the advisor's DATEV numbers and accounts per client ([f53af88](https://github.com/fabianbormann/Coineda/commit/f53af880aaccf4471fdbd98728e8c6d68d856fcc))
* **kraken-csv:** map the ECB-published fiat currencies and price non-base fiat at the ECB rate ([5a44c63](https://github.com/fabianbormann/Coineda/commit/5a44c6379e09e561729f7042eb6a2d92cee19b0a))
* **ledger:** fingerprint the events a report and a checkpoint are built from ([758f23c](https://github.com/fabianbormann/Coineda/commit/758f23ce2240308af8d2b0ca253154ab12a94b1e))
* **ledger:** give every reward a typed kind set by its source ([ff9caef](https://github.com/fabianbormann/Coineda/commit/ff9caef08920ffea3e27b6d0cd2c1d29546a6922))
* **ledger:** make the active database switchable and refuse writes across a switch ([e3e7b63](https://github.com/fabianbormann/Coineda/commit/e3e7b630f770b7ef86d44e773bdb0c83136eb95a))
* **ledger:** record margin and futures settlements as derivative events ([3748e87](https://github.com/fabianbormann/Coineda/commit/3748e8714f170a16ba6ac31ad4c657008bce2faa))
* let the balance arrive as a counter instead of a jump ([3154a91](https://github.com/fabianbormann/Coineda/commit/3154a9101237dca4dfc0b9ddc4033aafcc20d6cd))
* pour the journey into a jar along a timeline ([eedbc7e](https://github.com/fabianbormann/Coineda/commit/eedbc7ecf950fb4601fa67cceeb398ef69c2a3d4))
* **prices:** price fiat assets at the ECB reference rate ([33d11a1](https://github.com/fabianbormann/Coineda/commit/33d11a166249dffa290ee5e04f90ce59d9402ead))
* **prices:** record which source priced every valued row ([d4d7c8b](https://github.com/fabianbormann/Coineda/commit/d4d7c8bc41281bac685f1081ad9d92136e14a1af))
* **review:** make the screens read-only for a review client and print the client on every page ([9cce1ff](https://github.com/fabianbormann/Coineda/commit/9cce1ff44eba6d81547c0c8b852638210f282194))
* **review:** open a checkpoint as a read-only review client with a fingerprint verdict ([f0c3de6](https://github.com/fabianbormann/Coineda/commit/f0c3de68bd25b8aca1ee9dbbaf230c9b64ff8150))
* **security:** serve one Content-Security-Policy in both shells and harden the Electron window ([2c6bf0e](https://github.com/fabianbormann/Coineda/commit/2c6bf0ee7ccc28816561501079ac90c5ab1a88e4))
* **settings:** enter the tax number in the format of the chosen Bundesland ([ce2a790](https://github.com/fabianbormann/Coineda/commit/ce2a790f297fb461de62a6ae73c8e842e48a0a78))
* **sources:** accept several addresses for the Ethereum and Cardano sources ([3a7878a](https://github.com/fabianbormann/Coineda/commit/3a7878ac68940f50265ba90f8e7ad0d267c7d913))
* **sources:** import any CSV through an explicit column mapping ([27cf081](https://github.com/fabianbormann/Coineda/commit/27cf08120bd73801b2deca969a46f92e2375fe78))
* **sources:** import Ledger Live operation history CSVs ([3fff3b6](https://github.com/fabianbormann/Coineda/commit/3fff3b66e6b36ca7afd167cacc8cc070d7da35f8))
* **sources:** know USDT and USDC so stablecoin settlements and balances are priced ([7bdff66](https://github.com/fabianbormann/Coineda/commit/7bdff66174227ceaff812890c88617783de53bc7))
* **sources:** map any CSV's columns in a dialog and import it ([7d3137e](https://github.com/fabianbormann/Coineda/commit/7d3137e6fec0b438ddc71043145b10d77376c875))
* **sources:** parse mapped CSV dates strictly by format and zone ([88f6b49](https://github.com/fabianbormann/Coineda/commit/88f6b49c44f6371e7298f1969fef161b70f28e7a))
* **tax-report:** download the German report as a DATEV Buchungsstapel ([941d402](https://github.com/fabianbormann/Coineda/commit/941d4027280400a1bea9c989f6f64f80bc8031c5))
* **tax-report:** export the year's register as CSV and JSON and prove lots are consumed once across years ([d4e3406](https://github.com/fabianbormann/Coineda/commit/d4e3406b91ba21a17d210a007a22edd096a31500))
* **tax-report:** label derivative rows by kind and complete the §20 wording ([9d0ce65](https://github.com/fabianbormann/Coineda/commit/9d0ce65148607b713ccd5773779e96c8a7ffa004))
* **tax-report:** name each wallet's public addresses and keys in the source directory ([7431f73](https://github.com/fabianbormann/Coineda/commit/7431f73e1fc4b90787089b59792798827709c02a))
* **tax-report:** name the base currency on every register row ([df694a2](https://github.com/fabianbormann/Coineda/commit/df694a23991970028670da3720b7509d432adea3))
* **tax-report:** name the year, jurisdiction, time and gaps in the report JSON ([2f3740a](https://github.com/fabianbormann/Coineda/commit/2f3740a3b43d895dd874f254ad872cf526d78ee0))
* **tax-report:** navigate with breadcrumbs, span the action bar and group the form with defaults ([191d220](https://github.com/fabianbormann/Coineda/commit/191d22034047287ddd62e8db63bcd2667b02d861))
* **tax-report:** print a filing aid in form order and include it in the JSON ([d4327e9](https://github.com/fabianbormann/Coineda/commit/d4327e97589ab83e65ddfcf908605a36687377ab))
* **tax-report:** state the egress mode and the data hosts on the method sheet and in the JSON ([dd19d6d](https://github.com/fabianbormann/Coineda/commit/dd19d6d80fd0a74cdc3525b7988e6cc76c830d9b))
* **tax-report:** tell the three kinds of register gap apart and fill their notes ([6110450](https://github.com/fabianbormann/Coineda/commit/6110450a7defbb485aa4a520766b11603813efc4))
* **tax-report:** trace each register row to its provider record and source ([a116869](https://github.com/fabianbormann/Coineda/commit/a116869508cca52e72f595aa7e06ebff7cccd041))
* **tax:** apply a declared loss carry-forward to §23 and §20 after the Freigrenze test ([b5d1e87](https://github.com/fabianbormann/Coineda/commit/b5d1e8755be66b1ec337a447c89dde53b7bca10e))
* **tax:** apply valued transaction costs to cost basis and proceeds ([18afec1](https://github.com/fabianbormann/Coineda/commit/18afec1658e423efd8c555a71ce0d6ab8a0043e8))
* **tax:** build the Anlage SO and KAP filing figures for Germany ([ba502cd](https://github.com/fabianbormann/Coineda/commit/ba502cd52b6b7726f0d029b56f7e5c4fcf56a372))
* **tax:** carry capital gains and losses from derivatives through the engine and onto the report ([376ac44](https://github.com/fabianbormann/Coineda/commit/376ac447e6f573c6c122a7ef917c2b8e3d24e33d))
* **tax:** classify staking, lending, mining, airdrop and fork rewards under German rules ([50ab8d4](https://github.com/fabianbormann/Coineda/commit/50ab8d447e234753916e258efe0515e76c597fe0))
* **tax:** deduct trade fees as transaction costs under §23 Abs. 3 EStG ([88bf0ee](https://github.com/fabianbormann/Coineda/commit/88bf0ee99fcd0edd9113fc26fac982e82a59362a))
* **tax:** dispose of the coins a transfer between your own wallets consumed ([84a497b](https://github.com/fabianbormann/Coineda/commit/84a497bdb22fce797af2e9b8ad5e40cd81851c52))
* **tax:** flag margin as a contested §20 reading and leave rollover fees undeducted ([1cb0858](https://github.com/fabianbormann/Coineda/commit/1cb0858a1955de52da5c2e52876ff4f0d5efb954))
* **tax:** itemise every income event on the report ([01b084a](https://github.com/fabianbormann/Coineda/commit/01b084a23aa8ebd9adab1f2922f73ee101a1a897))
* **tax:** label a transfer fee disposal on the printed report with its origin and hash ([1ff280a](https://github.com/fabianbormann/Coineda/commit/1ff280a3e075c22166a1fddb8428b057b8f0b6a1))
* **tax:** let a jurisdiction declare a default personal rate and record the rate used ([ae2b9c2](https://github.com/fabianbormann/Coineda/commit/ae2b9c252f1d4a544af391943d474d4a26e65158))
* **tax:** name the kind of every income row and value a zero amount as zero ([5a64510](https://github.com/fabianbormann/Coineda/commit/5a645100bf003e317654ae08e2529424cf526a6a))
* **tax:** record the fiat actually paid or received as a trade's consideration ([9479980](https://github.com/fabianbormann/Coineda/commit/9479980b0ef8daf5c5db08c93fe017696406bc03))
* **tax:** record the price source of every cost and explain fork lots ([59d9b13](https://github.com/fabianbormann/Coineda/commit/59d9b13df13e30c0b39c283c053bdd768b2ee1ba))
* **tax:** show the fee share of every consumed lot ([694bf41](https://github.com/fabianbormann/Coineda/commit/694bf416b08c9c078866dea40d1e4ab650d2fcdd))
* **tax:** tax derivative settlements as capital income under §20 EStG ([1e88e65](https://github.com/fabianbormann/Coineda/commit/1e88e6590d2fb983a1be39eeacaf9ec908db1add))
* **tax:** treat a fee paid to receive a reward as a disposal and as Werbungskosten against the income ([f37ddc2](https://github.com/fabianbormann/Coineda/commit/f37ddc2d6c885b93b0fdaf706856ced42b487dac))
* **tax:** value a trade at the fiat actually paid or received ([a29a802](https://github.com/fabianbormann/Coineda/commit/a29a80269ad82321b7a15dfaa9a0568459c1c847))
* **tax:** value the transaction costs a jurisdiction attaches to an event ([dc1b26b](https://github.com/fabianbormann/Coineda/commit/dc1b26b12fc899e4a3dbd3d4844958c220ab1668))
* **tax:** version every rule set and print it on the report ([5ca0d01](https://github.com/fabianbormann/Coineda/commit/5ca0d019e822784fcf8b42687fb0122faf21364b))


### Bug Fixes

* **a11y:** announce why the last client cannot be deleted and mark required fields once ([87c09e8](https://github.com/fabianbormann/Coineda/commit/87c09e83dd076c3b89b8e62909e3a7b9fd5d097c))
* **a11y:** correct form semantics, heading levels and the drop-zone input ([0ccdeda](https://github.com/fabianbormann/Coineda/commit/0ccdeda618672c6da5f736a16070d4a231b6f077))
* **a11y:** disable Tailwind variant animations under reduced motion ([3144754](https://github.com/fabianbormann/Coineda/commit/31447549f4efc05c215ca7daafa12080626251cf))
* **a11y:** give onboarding headings and a title, translate dialog close buttons, and gate the remaining screens ([4499333](https://github.com/fabianbormann/Coineda/commit/4499333423219d59ff2397423b1a46d8ec6a2711))
* **a11y:** keep first-load focus on the skip link and move focus only on later navigations ([a8e5116](https://github.com/fabianbormann/Coineda/commit/a8e51167d57be2c713d68afdff613b04893b6a6c))
* **a11y:** make focus and highlighted items visible, expose toggle states, and announce report steps ([51b00c7](https://github.com/fabianbormann/Coineda/commit/51b00c77d6057fa30eb3d809bba88a009b1d1a32))
* **assets:** honour chain hints strictly and price legacy MATIC as POL ([566e932](https://github.com/fabianbormann/Coineda/commit/566e932e51bb3768be18c21f7cae4b5be39f3eea))
* **binance:** keep wallet transfers distinct and read a futures rebate as received ([be13687](https://github.com/fabianbormann/Coineda/commit/be136879f39ee89362d1398d74a7be1b85b6b94a))
* **cardano:** type only member and leader rewards, never a deposit refund ([b10bca5](https://github.com/fabianbormann/Coineda/commit/b10bca5ab6b40bd2baabc1e8aabd4065c9ec04bc))
* **carf:** count wallet transfers by hash link, sum fiat in the base currency only, and reach the nothing-to-report case ([94ff964](https://github.com/fabianbormann/Coineda/commit/94ff964117fe27e1776c20fac25b70d78164a01b))
* **carf:** state the comparison's limits on the report and tidy the dialog ([67a6b42](https://github.com/fabianbormann/Coineda/commit/67a6b422bd9f6b9770a0c0c7706555985a88c5c1))
* **clients:** always keep one client ledger in the registry ([38a49d4](https://github.com/fabianbormann/Coineda/commit/38a49d4a5532546ef20a5222cbc1a3c56f09d300))
* **clients:** confirm deletion against the displayed label and never leave the gate stuck ([7892379](https://github.com/fabianbormann/Coineda/commit/7892379ab07ff32810c81d864fc254c55cdbaaf1))
* **config:** ignore empty endpoint overrides and distinguish configured hosts from public defaults ([6c039bb](https://github.com/fabianbormann/Coineda/commit/6c039bb74f98b5af896bd3a8eeba74ad22c2b9af))
* **config:** keep the egress mode and endpoints on the device so review clients and settings errors cannot reopen egress ([aed4e4b](https://github.com/fabianbormann/Coineda/commit/aed4e4bcad969d762508776cd6933bc96822951f))
* **config:** pin builds ignore device overrides, fetchers default to the restricted-aware endpoints, and the build validates its egress env ([5567d89](https://github.com/fabianbormann/Coineda/commit/5567d89f31080be024b297ae79e981c5e7220ee3))
* **csv:** make the delimiter sniff opt-in and refuse amounts whose commas are not thousands groups ([2c9963f](https://github.com/fabianbormann/Coineda/commit/2c9963f5f88e32332629ba4de689d9838cc5edbb))
* **csv:** refuse a leading zero group as a thousands separator ([294516e](https://github.com/fabianbormann/Coineda/commit/294516e5f566a76b32a05f1a1cd1cb2966becca3))
* **csv:** refuse amounts with more than one decimal separator ([b75fbff](https://github.com/fabianbormann/Coineda/commit/b75fbff3b3ad14aafea870a569cfbd740131b5a1))
* **datev:** keep the settings card disabled until the stored values are loaded ([99f7970](https://github.com/fabianbormann/Coineda/commit/99f7970ce340d7a5c900baf11882f423c3b69323))
* **datev:** print whole-unit amounts and real symbols in the booking text and keep the header label within 30 characters ([bb5cb61](https://github.com/fabianbormann/Coineda/commit/bb5cb61752e4c14a2ce63eee36e767b17a82cb39))
* **datev:** say the postings are pre-threshold, validate live settings, and allow session-only settings in a review ([f41562b](https://github.com/fabianbormann/Coineda/commit/f41562b65e92c9baa2d3c2d6e88397e7cc5a5c21))
* **kraken-csv:** group a trade's ledger rows by refid so the fee reaches the report ([f15713d](https://github.com/fabianbormann/Coineda/commit/f15713d73e139384fb58ae66a71317d3e3674f53))
* **kraken-csv:** group transfer rows by refid and retire the per-row events they replace ([e100c82](https://github.com/fabianbormann/Coineda/commit/e100c822b4a95c785555c589ee281051741dbada))
* **kraken:** leave an earn allocation with no refid untyped as a reward ([873b9d8](https://github.com/fabianbormann/Coineda/commit/873b9d8596984a00ddd96d37f298d9b6f1339a6e))
* **ledger:** carry the starting ledger through long writes and enforce read-only at the store ([c095312](https://github.com/fabianbormann/Coineda/commit/c095312439675dcd244a657227a45faee02c095f))
* **ledger:** fingerprint raw events together with manual links, and order events totally ([692bcfa](https://github.com/fabianbormann/Coineda/commit/692bcfa2740a3a1d358772f8bee96f4828aa7e4e))
* **ledger:** switch the active name before closing so a concurrent open cannot reopen the old database ([f0bd76d](https://github.com/fabianbormann/Coineda/commit/f0bd76dca6e650e4f95badebcf71eedfba84133d))
* **review:** keep public addresses when stripping credentials and name the client only when there are several ([8bc1301](https://github.com/fabianbormann/Coineda/commit/8bc1301c4b9d0dc2f8321b898f0d5341b09205d5))
* **review:** show the fingerprint verdict in the banner and reuse the shared short-fingerprint helper ([1532520](https://github.com/fabianbormann/Coineda/commit/1532520425d02395415e8bc492e41172c12bb107))
* **security:** compare the custom scheme by protocol and host, redact before truncating, strip the price key from review copies, and deny permissions ([a9a0c27](https://github.com/fabianbormann/Coineda/commit/a9a0c27cdbb5de7329543a5bcf81e1b3edfbcecd))
* **security:** guard the Bitpanda redaction against short keys and forward anchor props on external links ([5753882](https://github.com/fabianbormann/Coineda/commit/575388264b889769e260b45250292dd2ebea3ded))
* **security:** keep the dev server working under the CSP and precache the theme script ([a6ba710](https://github.com/fabianbormann/Coineda/commit/a6ba7101bbaec694aff9456a7ba1a5d91fe73f95))
* **security:** mark external links and never echo an API key in an error ([822efb4](https://github.com/fabianbormann/Coineda/commit/822efb44bb69220152f38b23c27569d0b6828529))
* **sources:** book Ledger Live gas once and keep identical flattened rows apart ([d8dc7bd](https://github.com/fabianbormann/Coineda/commit/d8dc7bdf78122b5e1d2059ca0dd3ed4a53f08c7a))
* **sources:** book Ledger Live sends net of the fee and resolve natives before tokens ([7954479](https://github.com/fabianbormann/Coineda/commit/7954479d00ec394258fbbbd6301c6c8cda76e79c))
* **sources:** keep every Cardano reward type apart, survive a transient address 404, and fetch utxos three at a time ([88cbe72](https://github.com/fabianbormann/Coineda/commit/88cbe72d421b7a2042a18631db5b5853ee702669))
* **sources:** leave ambiguous same-second Binance rows ungrouped and stop validating an unused Coinbase column ([5827b0e](https://github.com/fabianbormann/Coineda/commit/5827b0ef15c70b6fee024274c84d49eb403b01c7))
* **sources:** never delete a venue's events without being asked, and replace them atomically when asked ([6c8890d](https://github.com/fabianbormann/Coineda/commit/6c8890d77092565138b7ca96791f5678547ded6b))
* **sources:** pair Binance trade rows, scale Coinbase subtotals strictly, and resolve Kraken DOGE ([944ca80](https://github.com/fabianbormann/Coineda/commit/944ca802e122c3d5001ce693ca3c3c8aa1eaef2f))
* **sources:** pin fiat legs in the exchange importers and add Kraken codes for the new natives ([eebe240](https://github.com/fabianbormann/Coineda/commit/eebe2409ca0c4c7b4e85678b556958cafd7ef791))
* **sources:** pin the mapping dialog's error paths in tests and label event kinds ([fd56677](https://github.com/fabianbormann/Coineda/commit/fd566777e7a9e670c8e5e049476f5de24c94ea5a))
* **sources:** scale mapped fiat strictly, keep fee rows as fees, name the fiat counter currency, and make direction tags exclusive ([64cae07](https://github.com/fabianbormann/Coineda/commit/64cae074884272ed362e0e48a94bb4f35c89737c))
* **sources:** show the mapped-CSV preview warnings in the dialog ([7d9de45](https://github.com/fabianbormann/Coineda/commit/7d9de4598371696b55ad90292093ff3cfe4ba836))
* **sources:** supersede the pre-split Cardano reward rows and let API pages replace stale events ([bcfb320](https://github.com/fabianbormann/Coineda/commit/bcfb320fcf1e3d8791c1b005913a400be24301c8))
* **sources:** take mapped counter amounts by magnitude and only refuse zero ([4f7b78d](https://github.com/fabianbormann/Coineda/commit/4f7b78d9d318219d412091fdc598423eff3c67ff))
* **sources:** validate mapped columns against the file, replace a venue's events when its mapping changes, and warn on one-directional sign mapping ([030347b](https://github.com/fabianbormann/Coineda/commit/030347b8f41ee826b2f15b6b7e6c61dde7206108))
* **tax-report:** count only this year's gaps on the filing aid and drop non-euro filing from the JSON ([a59a4b4](https://github.com/fabianbormann/Coineda/commit/a59a4b4a5f091110660467f8f5dd3152bb0099a9))
* **tax-report:** defuse spreadsheet formulas in register CSV cells ([2f56810](https://github.com/fabianbormann/Coineda/commit/2f56810fe34a47b6203dac36a8384a816c600d82))
* **tax-report:** exclude the share-loss pot from the §20 carry-forward input ([bf726cc](https://github.com/fabianbormann/Coineda/commit/bf726cca2bfc142c55dbb6ea748e853b3e2f1116))
* **tax-report:** give each derivative row a unique key ([2bbcbd0](https://github.com/fabianbormann/Coineda/commit/2bbcbd0a261aba5b154bedb75576236cfde25445))
* **tax-report:** keep the rate editable in a review and harden the tax number input ([e07d942](https://github.com/fabianbormann/Coineda/commit/e07d9420d906a329ca6a7f168a7d970ed37cdd36))
* **tax-report:** label the carry-forward inputs with the Bescheid's year-end figure ([95fe7c0](https://github.com/fabianbormann/Coineda/commit/95fe7c080a733a5f594d12eae8667f75a3aea86e))
* **tax-report:** name the carry-forward as the Finanzamt's figure and note it beside a loss to declare ([27bbba4](https://github.com/fabianbormann/Coineda/commit/27bbba4caacdc46460c912d5d6762bc9f9b8f507))
* **tax-report:** pair internal transfers across year boundaries and make the multi-year check discriminating ([7419955](https://github.com/fabianbormann/Coineda/commit/7419955529ec7b84c848c8ffc363769aac39029c))
* **tax-report:** print the §20 carry-forward between the net result and the allowance ([2c820f4](https://github.com/fabianbormann/Coineda/commit/2c820f4d4e9a87f236d5bd31a9c724dfffc0cca8))
* **tax-report:** print the gain to declare before a carry-forward and mark the reduced figure an estimate ([5244144](https://github.com/fabianbormann/Coineda/commit/5244144a47da813cf3176f64d5d8c21c46000de9))
* **tax-report:** print the jurisdiction's name with the rule-set version ([a97885f](https://github.com/fabianbormann/Coineda/commit/a97885fc8b971cecc8ed8ff92ca2fdcfd4de880d))
* **tax-report:** seed the carry-forward inputs for the year showing when settings land late ([71dffb6](https://github.com/fabianbormann/Coineda/commit/71dffb69066fbd1903995d973bc525f328a5ac14))
* **tax-report:** snapshot the egress mode and endpoints at run start and list only the hosts a run used ([b3f1a6b](https://github.com/fabianbormann/Coineda/commit/b3f1a6b0c665f1fb415202c367c206e2bfb5e2ef))
* **tax-report:** state the Finanzamt sentence once under the filing aid ([52fed6c](https://github.com/fabianbormann/Coineda/commit/52fed6c59fe91774d837b8fda238cc53a705146a))
* **tax-report:** tie register rows to year and fingerprint, word the fingerprint lines exactly, and warn about xpub disclosure ([d054045](https://github.com/fabianbormann/Coineda/commit/d05404536be2c4f7b3cba5212d48e811501dbcb8))
* **tax-report:** translate the host's own words in a row's price source ([0dd7f67](https://github.com/fabianbormann/Coineda/commit/0dd7f67270247502ea2c486cfda18d2b39753e40))
* **tax-report:** warn when filing figures are incomplete or not in euros, and name the line source ([2bbe579](https://github.com/fabianbormann/Coineda/commit/2bbe5799cd533738fd1925c970efa9ea2ea5d578))
* **tax:** count only residual disposals on the method sheet, with plural forms ([86ca56d](https://github.com/fabianbormann/Coineda/commit/86ca56db4d81d8af3d19b954e15c3e5eb31c6610))
* **tax:** decide the one-year holding period by calendar date, not day count ([12e66d2](https://github.com/fabianbormann/Coineda/commit/12e66d20a9f1e760f4b9a7c482fcc7ddeecb0612))
* **tax:** keep Austria's trade consideration off a crypto fee leg's disposal ([3603002](https://github.com/fabianbormann/Coineda/commit/3603002a3b1d4fd462cc751eeba949151f25131f))
* **tax:** label an unpriced fee as a deduction not made, not a failed disposal ([0c9f5a5](https://github.com/fabianbormann/Coineda/commit/0c9f5a595abea2000626ad20b8ec78d7d3142703))
* **tax:** label legacy income rows, point the airdrop note at the BMF letter and close review gaps ([6babbba](https://github.com/fabianbormann/Coineda/commit/6babbbad9955991206dcc711b60a02fe3ff0d97d))
* **tax:** leave Austrian reward kinds without a rule unclassified ([a634bc9](https://github.com/fabianbormann/Coineda/commit/a634bc9ac4f5c2b09f302cfa64b9bee20805a2d1))
* **tax:** mark the filing indicators with 1 and pin exempt costs out of the expenses ([8e91668](https://github.com/fabianbormann/Coineda/commit/8e916685586c4b1480cd3d5d9b4c153ddab10c0a))
* **tax:** move lots across venues for a single-event internal transfer ([6bb143c](https://github.com/fabianbormann/Coineda/commit/6bb143c77c9056762f475dc2f3572841d9c92b6c))
* **tax:** name the §22 Nr. 3 Freigrenze for other income and scope it ([f0c23e4](https://github.com/fabianbormann/Coineda/commit/f0c23e435dcfd634c49fac0444768ee4437b8406))
* **tax:** net §22 Nr. 3 income per year, bump the Austrian rule set, and add upgrade notes ([b294ed6](https://github.com/fabianbormann/Coineda/commit/b294ed650e66508a3f7184e73bf1e216de1fa7bd))
* **tax:** print sale value, fees deducted and proceeds after fees on a disposal ([32c6f27](https://github.com/fabianbormann/Coineda/commit/32c6f270cdfa0451bb7f3988e8036409a91e2507))
* **tax:** report the Anlage KAP net figure on line 19 and omit an empty derivatives section ([a78df19](https://github.com/fabianbormann/Coineda/commit/a78df195a7fde426434020105e74516d2f444395))
* **tax:** report the saver's allowance on the net after a §20 carry-forward ([dff0678](https://github.com/fabianbormann/Coineda/commit/dff0678f5a53fa100eb14b26d44d98ac2678db4b))
* **tax:** validate a carry-forward before storing it, tighten the versioning gate and document the carry contract ([07ed414](https://github.com/fabianbormann/Coineda/commit/07ed4149a5896191159933448f6abfaf4694db9e))
* **tax:** version Austria's figure-changing rules as 1.1.0, checked on 9 October ([bbfabcc](https://github.com/fabianbormann/Coineda/commit/bbfabcc141dd89f88916df9bfe4d7faa94aef887))
* **transfers:** decide sender and receivers on each event's net and link every owned receipt ([ad679a6](https://github.com/fabianbormann/Coineda/commit/ad679a68e6a47ffe958bd2a9a01442d6c40f4ac3))
* **transfers:** keep coins paid to someone else apart from the fee of a transfer to yourself ([6c182f8](https://github.com/fabianbormann/Coineda/commit/6c182f8d20b606490ec318385a101ad94dadde71))

## [0.2.12](https://github.com/fabianbormann/Coineda/compare/v0.2.11...v0.2.12) (2026-10-07)


### Features

* accept the zip Kraken actually sends, and name the right export ([13065aa](https://github.com/fabianbormann/Coineda/commit/13065aa2437ef367c2a5f82de290b1a7ac812cc8))
* add Bitcoin as a source through Esplora ([63c3a1a](https://github.com/fabianbormann/Coineda/commit/63c3a1ad109f8238f8a9905df4e5a08417ba4117))
* add Bitpanda as a data source ([ab0d945](https://github.com/fabianbormann/Coineda/commit/ab0d9455a64dd32630d47a86a6c70ee2d9e3cbb6))
* add Ethereum as a data source, through Blockscout ([77ec89e](https://github.com/fabianbormann/Coineda/commit/77ec89e5f874ae02b32be5a438f5e0c5666cf137))
* add tax reports, price resolution and a shareable crypto journey ([f7990d7](https://github.com/fabianbormann/Coineda/commit/f7990d76d8331fa6c857c5d1ce4b0bfb345f4601))
* add the tailwind design foundation, dark mode and a new app shell ([6e35191](https://github.com/fabianbormann/Coineda/commit/6e35191d096e618c66dfb012dbbc42ddfad76a7b))
* add the UI foundations the page rebuilds will consume ([9d4f335](https://github.com/fabianbormann/Coineda/commit/9d4f3355fe67b3b53d2e82362efaf5b0fba18e4c))
* add the unit boundary an exchange source needs ([abe9c48](https://github.com/fabianbormann/Coineda/commit/abe9c480a482355e55ae5aadf555cab2fdfd07fe))
* apply the Lumen glass theme ([09cdcf3](https://github.com/fabianbormann/Coineda/commit/09cdcf3d8adda7bb2549b96a244cbe74da13d571))
* argue each disposal in the reader's language, not English ([ec9d5b3](https://github.com/fabianbormann/Coineda/commit/ec9d5b3301bd3e101715df6456ae0df5544da2b2))
* ask for an account xpub, with the address list as an advanced option ([f794af3](https://github.com/fabianbormann/Coineda/commit/f794af30229b9445dbdbb34ade1edb133e073de4))
* carry confirmed transfers in a checkpoint, and always offer the file ([a973346](https://github.com/fabianbormann/Coineda/commit/a973346c6c2a64686bca357900b081758092ba6e))
* carry each disposal's quantity, venue and lots into the report ([ceca89e](https://github.com/fabianbormann/Coineda/commit/ceca89e4df5c759cb1060409c7feeb3ea3331b88))
* carry the recorded transactions in a checkpoint too ([e845d6e](https://github.com/fabianbormann/Coineda/commit/e845d6eb4bc3fc2166b945914e58674305db9d6a))
* detect a Bitcoin wallet's address type by probing the chain ([fc21d3c](https://github.com/fabianbormann/Coineda/commit/fc21d3c19149efee4554830aea34fb6b86132e40))
* draw the chain icons white in dark mode ([35405f6](https://github.com/fabianbormann/Coineda/commit/35405f63be2b812be29d79ffc60967d3ac35c213))
* draw the journey as a lit rail of buys and sells ([cdc70f3](https://github.com/fabianbormann/Coineda/commit/cdc70f3661e24abb61e2163b3a56c6cdbb394ac8))
* encode a derived public key as each Bitcoin address type ([03cbe3c](https://github.com/fabianbormann/Coineda/commit/03cbe3c8856fb74822c05a67987bbf7a57d132df))
* give the printed report a letterhead, a colophon and a top margin ([c3ebc54](https://github.com/fabianbormann/Coineda/commit/c3ebc54f3ce1d3cb1a361d6818d69e693b03bfc8))
* import Binance and Coinbase exports too ([e723ff8](https://github.com/fabianbormann/Coineda/commit/e723ff846d1089f555b3da24ddf783055c628164))
* import Kraken's ledger export as a data source ([3edddb3](https://github.com/fabianbormann/Coineda/commit/3edddb36ed12fa644b0eb9f73eab218867bb9e8b))
* let a configured source be edited ([802f9e2](https://github.com/fabianbormann/Coineda/commit/802f9e22a8e7f34f84f0733266f218ceb0a439cd))
* let a manifest hide a field behind an advanced switch ([2c64d73](https://github.com/fabianbormann/Coineda/commit/2c64d7334cdd7373fe6d1d73a1014787d0249593))
* let you confirm a transfer your exchange reports no hash for ([c666f56](https://github.com/fabianbormann/Coineda/commit/c666f566a76b57ee9e4ec840d19eeef3da05e596))
* let you reset this device back to the welcome screen ([54a0618](https://github.com/fabianbormann/Coineda/commit/54a061816a2333103556e17b53d69a7971549fce))
* make the code a handover and the file a backup, and say which is which ([f037b47](https://github.com/fabianbormann/Coineda/commit/f037b4798d960cef3d374085d6f6cea852ae573f))
* make the form and the report two steps instead of one scroll ([cbe3ad9](https://github.com/fabianbormann/Coineda/commit/cbe3ad9fb13412a6f3709888b13db72a80029d04))
* make the journey about coin amounts, with the price only at the end ([b6d8dd4](https://github.com/fabianbormann/Coineda/commit/b6d8dd4a805321c4990621b8e369a4a3480b55a3))
* make the masthead a link back to the overview ([bca624b](https://github.com/fabianbormann/Coineda/commit/bca624b0a4f44a9147bb73a1cb0cdc83c86323c0))
* migrate to vite, refresh dependencies and deploy to github pages ([13bc2f4](https://github.com/fabianbormann/Coineda/commit/13bc2f4604b783f8f3fe711cfbcb7d46b4f320fc))
* name the disposals a report could not compute, and stop printing the rest ([e97bec0](https://github.com/fabianbormann/Coineda/commit/e97bec00993058764128c086f669a89708296ef2))
* name the wallets and exchanges every figure came from ([e10091f](https://github.com/fabianbormann/Coineda/commit/e10091f3cacea4e420d79cae7f8af97d053cdfd7))
* parse and validate a Bitcoin account extended public key ([a3c02ab](https://github.com/fabianbormann/Coineda/commit/a3c02ab04a652325b4b05a3f62cd00b09b68c3b0))
* price history beyond CoinGecko's 365-day free tier ([c9aa613](https://github.com/fabianbormann/Coineda/commit/c9aa613e20cfb85c2d0dfb1886091856ddc8d397))
* print the acquisition date behind every holding period ([8f0e256](https://github.com/fabianbormann/Coineda/commit/8f0e2566f8a5412bb5b5398b055be6df7b2de340))
* print the tax report, or save it as PDF ([4ff625a](https://github.com/fabianbormann/Coineda/commit/4ff625a496a6f4aca18e2f9d2902610d676e9c42))
* print who the tax report is for ([f05911a](https://github.com/fabianbormann/Coineda/commit/f05911aec39abf1368632826ea93d3c543620e35))
* put file import in the Add-a-data-source dialog ([a5ad7e2](https://github.com/fabianbormann/Coineda/commit/a5ad7e2dcfa68dbde1cfd62e5b11a80d598144d5))
* rebuild Coineda on an append-only event ledger with pluggable sources ([861ce7e](https://github.com/fabianbormann/Coineda/commit/861ce7ed2e04d799ed5c99b4369ba7fc17b06b63))
* rebuild settings and wallets on the new UI foundations ([510b468](https://github.com/fabianbormann/Coineda/commit/510b46873bc15094f241dfe00ee5c3fbe85905c0))
* rebuild the balance header on Lumen's header panel ([1b485b6](https://github.com/fabianbormann/Coineda/commit/1b485b6af1f4afa8c76e6b537f5a1752d3a888cd))
* replace the logo everywhere with the new mark ([a134f8c](https://github.com/fabianbormann/Coineda/commit/a134f8c0bfbeac7555b04565b14b14031cfc7411))
* resolve a Cardano account from the address bytes ([96c9582](https://github.com/fabianbormann/Coineda/commit/96c95829aae5b2f26e45881a8c3c4adf147013f8))
* resolve Cardano native assets and draw asset icons ([b54eede](https://github.com/fabianbormann/Coineda/commit/b54eede3820b2da55d8ff3daa1277b75cc95d26f))
* say how much of the unresolved list the tax year accounts for ([8e4ca15](https://github.com/fabianbormann/Coineda/commit/8e4ca158eadd9ea5515fb5f4b41421cb880aba5a))
* say what could not be computed in the reader's language ([bdb5f92](https://github.com/fabianbormann/Coineda/commit/bdb5f92c4e08785322ef47d58e98e3f6c759ea49))
* scan a derived Bitcoin wallet across both chains and listed addresses ([8f489ff](https://github.com/fabianbormann/Coineda/commit/8f489ffe571fbe6cb753ae2a1633f98ef9726176))
* show a source's priced holdings, most valuable first ([6a47aaf](https://github.com/fabianbormann/Coineda/commit/6a47aafd29718f9b02ee9e5613f67d12d99e89ac))
* show each data source's holdings and its event log ([73447ec](https://github.com/fabianbormann/Coineda/commit/73447ecc673512adc1d9b8665f0aa330e6a8a060))
* state the method, the price sources and the valuation day ([7b60bcd](https://github.com/fabianbormann/Coineda/commit/7b60bcd356209952f4dfd5e99c162abf3351f5fd))
* track a whole Cardano account, not one payment address ([2b9c1c2](https://github.com/fabianbormann/Coineda/commit/2b9c1c2e7db92be6984630fb80ad6e660b1c6e48))
* treat a transfer between your own venues as internal, not a sale ([f81e9c7](https://github.com/fabianbormann/Coineda/commit/f81e9c77f9e16a77cc0468cdb3a92b3039f021d8))


### Bug Fixes

* cite the BMF letter that is actually in force ([c92ed41](https://github.com/fabianbormann/Coineda/commit/c92ed41a01a4c8c260f1a3abd50fa411ac694e3a))
* correct the Bitpanda parser against the real API ([76e8806](https://github.com/fabianbormann/Coineda/commit/76e8806f183653b590afdc4e3074ae4d40a51b14))
* drain Bitpanda movements, not just trades ([e23a193](https://github.com/fabianbormann/Coineda/commit/e23a193b0bd37072ac822808dd94265c7d6cd691))
* give a chain wallet its bubbles, and the filament its bloom ([7265d70](https://github.com/fabianbormann/Coineda/commit/7265d70432f2407e73e973296652ba30eb63723d))
* give dark token logos a light plate in dark mode ([85a003d](https://github.com/fabianbormann/Coineda/commit/85a003d211e2068996ab9a45ca593809dd964fcc))
* give the toast a surface you cannot read through ([840af6b](https://github.com/fabianbormann/Coineda/commit/840af6bfd1db23ae63536cb2708bc15fb265b60b))
* hide out-of-year unresolved items by default ([b0dfffb](https://github.com/fabianbormann/Coineda/commit/b0dfffb13946f54ecce987b62f25f3cd336c378b))
* import the Kraken rows a real export actually contains ([0e69c09](https://github.com/fabianbormann/Coineda/commit/0e69c099bffea4893c261e06043e381a5f15252c))
* ingest Bitpanda's fiat deposits so the balance adds up ([be95454](https://github.com/fabianbormann/Coineda/commit/be9545412b4324a97b9d6e6ef39aadf08636e51b))
* let a bubble's size say how much the trade mattered ([b32f965](https://github.com/fabianbormann/Coineda/commit/b32f9659bc69e9173ab2bca68be09e6edf203c0d))
* let each jurisdiction state what its own figures mean ([d31b483](https://github.com/fabianbormann/Coineda/commit/d31b4831c35b59f3eccbc8b924d79f346814b6d0))
* light the journey frame, which the port had left flat ([064f6f6](https://github.com/fabianbormann/Coineda/commit/064f6f6335cfdd8975c03a0bece9cdc51ab31d72))
* make the top bar a glass panel instead of a black one ([d2db8dc](https://github.com/fabianbormann/Coineda/commit/d2db8dc718706292981374334206476dc1f0e747))
* pad the tax report screen and size its controls ([ac2c94f](https://github.com/fabianbormann/Coineda/commit/ac2c94f5cc5ce4e9d25763fcddc3128acce67f75))
* price a whole span in one request instead of one per day ([b8bf846](https://github.com/fabianbormann/Coineda/commit/b8bf846ac078171df1ca5dbd5867aec2d99ed3ff))
* print the whole report, not the screen it was read on ([7667326](https://github.com/fabianbormann/Coineda/commit/76673260fd63fc42275c0a76c21d78abcd071ed9))
* put the whole-portfolio actions above the source list ([241b1d1](https://github.com/fabianbormann/Coineda/commit/241b1d1137cfb857e6301855191bbc2f779acfd1))
* raise the page bound so a derived wallet can finish a sync ([2e28ad9](https://github.com/fabianbormann/Coineda/commit/2e28ad963c631fe960806f98fa5c3b8748a7620d))
* read the unresolved list, and stop a dash reading as a minus ([7fdff75](https://github.com/fabianbormann/Coineda/commit/7fdff759b1a24ef247b056a32d71dd735454dd0e))
* report a losing year as a loss to declare instead of zero ([0e10377](https://github.com/fabianbormann/Coineda/commit/0e10377c8ee23dce3940d710cfed3972c5043b79))
* set the printed tax report as a document, not a screenshot of the app ([f3ee609](https://github.com/fabianbormann/Coineda/commit/f3ee6090aafd23af16b0934c30e5debdee9f613f))
* stop adding a solidarity surcharge nobody may owe ([bf3042c](https://github.com/fabianbormann/Coineda/commit/bf3042c9be6bb4492a115f1310cd2ad2161994bf))
* stop one disposal printing another's quantity and cost basis ([5631015](https://github.com/fabianbormann/Coineda/commit/563101566431a644ec6b40227e8aeb3e1b9e323c))
* stop painting typed text in the page background colour ([78385cb](https://github.com/fabianbormann/Coineda/commit/78385cbe09cf5be095f174e7986691c69de72ea2))
* stop the dialog frame scrolling with its contents ([f3dbf56](https://github.com/fabianbormann/Coineda/commit/f3dbf5612cc75ac25363c3c478d7908fcce1e249))

## [0.2.11](https://github.com/fabianbormann/Coineda/compare/v0.2.10...v0.2.11) (2023-02-22)


### Features

* modularize tax calculation ([d3145b3](https://github.com/fabianbormann/Coineda/commit/d3145b3ee246e5409a085ba64bf3ae1ed5e48d05))


### Bug Fixes

* repair tax view and wait with calculation to make sure the actual account has been selected ([c9f8cb8](https://github.com/fabianbormann/Coineda/commit/c9f8cb8c6fa0eecaa76a1c95da035266e3b26948))

## [0.2.10](https://github.com/fabianbormann/Coineda/compare/v0.2.9...v0.2.10) (2023-02-19)


### Features

* modularize api syncing and add Binance API sync as example ([e123f5e](https://github.com/fabianbormann/Coineda/commit/e123f5e4db7b75e706c856ccb41709df69cf5f07))


### Bug Fixes

* change path to repair tests ([e39d4cf](https://github.com/fabianbormann/Coineda/commit/e39d4cfc0dafbec5783263782a1cbf3535ee5e24))

## [0.2.9](https://github.com/fabianbormann/Coineda/compare/v0.2.8...v0.2.9) (2023-02-14)


### Bug Fixes

* account creation triggers a local storage update, add translation for error messages ([3f59b55](https://github.com/fabianbormann/Coineda/commit/3f59b556c920b811351177f39ee6e9e0ee49d304))
* prevent transaction editing to create a new transaction ([f747999](https://github.com/fabianbormann/Coineda/commit/f747999c1a912be73d40d7b45c17274335f17b0e))

## [0.2.8](https://github.com/fabianbormann/Coineda/compare/v0.2.7...v0.2.8) (2023-02-13)


### Features

* restart fetching of coingecko data after a certain time ([027db8d](https://github.com/fabianbormann/Coineda/commit/027db8d19821343cc2d39a146b133a5194a439ca))


### Bug Fixes

* repair import dialog ([b194068](https://github.com/fabianbormann/Coineda/commit/b19406887295f4b00df955e29d45477775bf936f))

## [0.2.7](https://github.com/fabianbormann/Coineda/compare/v0.2.6...v0.2.7) (2023-02-12)


### Features

* modularize imports and add tests for them ([24ac157](https://github.com/fabianbormann/Coineda/commit/24ac157e69fafcddc39b13dc6ebaa618ace8377d))


### Bug Fixes

* repair workflow that waits for creating the release ([d551d5e](https://github.com/fabianbormann/Coineda/commit/d551d5ec813c29b3e048e5f193c62c935ae7a884))

## [0.2.6](https://github.com/fabianbormann/Coineda/compare/v0.2.5...v0.2.6) (2023-02-05)


### Bug Fixes

* publish field for electron builder misses a provider ([a36c68b](https://github.com/fabianbormann/Coineda/commit/a36c68b204107765af51a3a457adb728c7c48c6f))

## [0.2.5](https://github.com/fabianbormann/Coineda/compare/v0.2.4...v0.2.5) (2023-02-05)


### Features

* add version+license info and github issue link. closes [#42](https://github.com/fabianbormann/Coineda/issues/42) ([78b59a9](https://github.com/fabianbormann/Coineda/commit/78b59a9b6896d9b67d1bb1b7d5dfa38b39ea56ec))

## [0.2.4](https://github.com/fabianbormann/Coineda/compare/v0.2.3...v0.2.4) (2023-02-04)


### Bug Fixes

* github actions pipeline for pwa and electron builds ([104bb4c](https://github.com/fabianbormann/Coineda/commit/104bb4c78f1a5bcff5d2f648e33894d91189695d))

## [0.2.3](https://github.com/fabianbormann/Coineda/compare/v0.2.2...v0.2.3) (2023-02-04)


### Features

* add more translations ([0c2ad6d](https://github.com/fabianbormann/Coineda/commit/0c2ad6dded9564610bf071e9d8ab534120cf32d6))
* improve histroy caching and fetching ([aa73927](https://github.com/fabianbormann/Coineda/commit/aa73927fd6a1e136e4c22bd806cb3032e3cad15c))
* remove all transactions and transfers after removing the account. solves [#25](https://github.com/fabianbormann/Coineda/issues/25) ([c2d1f18](https://github.com/fabianbormann/Coineda/commit/c2d1f1893ddf7c90e882cd51b61f8f4548188d6b))

## [0.2.2](https://github.com/fabianbormann/Coineda/compare/v0.2.1...v0.2.2) (2023-02-03)


### Bug Fixes

* repair mobile view closes [#54](https://github.com/fabianbormann/Coineda/issues/54) ([f2af18a](https://github.com/fabianbormann/Coineda/commit/f2af18a91e13cfae2a09e14374a2d450864ef199))

## [0.2.1](https://github.com/fabianbormann/Coineda/compare/v0.2.0...v0.2.1) (2023-02-02)


### Features

* add a new logo and refactor mui for the tax page ([7d79d09](https://github.com/fabianbormann/Coineda/commit/7d79d09717d98d2ca143b57d576d5f661430047f))
* add mui and remove all antd dependencies ([ceae085](https://github.com/fabianbormann/Coineda/commit/ceae08595024cef68e80ad09d83cfc230731c199))
* add release please build pipeline ([b30ee58](https://github.com/fabianbormann/Coineda/commit/b30ee5857cb2e801d6e9b79c59fc0e31210727ba))
* add typescript and mui in all ui components ([1f05e07](https://github.com/fabianbormann/Coineda/commit/1f05e07eda7636f951a8c6bc66e2b190e4d2c9fe))
* change wallet page from antd to mui ([b21f989](https://github.com/fabianbormann/Coineda/commit/b21f989761cbba74f955573f4eff1210901b7d5a))
* replacing the antd dialogs with mui dialogs ([72cbdff](https://github.com/fabianbormann/Coineda/commit/72cbdff8374b0056eb3decfb892a5c2b5589200f))


### Bug Fixes

* remove jss ([8e7f8df](https://github.com/fabianbormann/Coineda/commit/8e7f8df6eb3f2ac79bf75096e1b20fbc140b4677))
* remove unused issues page ([20034c8](https://github.com/fabianbormann/Coineda/commit/20034c8fc94af688110f92b6b2d19e80f0ddde49))
* remove unused types and imports ([38edbbd](https://github.com/fabianbormann/Coineda/commit/38edbbd59cb85e5a8ece3d6e0f7bae937062c154))
* repair layout of tax report page ([6e1b10c](https://github.com/fabianbormann/Coineda/commit/6e1b10c74a2904e7b7a48b1013d02e1eb6d7b46c))
* repair option rendering in add transactions dialog ([ee3ad80](https://github.com/fabianbormann/Coineda/commit/ee3ad80e73af215257d86b3a8a1e9ef9db464ab7))
