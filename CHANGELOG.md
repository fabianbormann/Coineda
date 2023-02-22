# Changelog

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
