#!/usr/bin/env -S npx tsx
// Records real provider responses into fixtures so nobody hand-writes JSON.
// Run by hand: npx tsx scripts/record-fixtures.ts cardano-blockfrost ./config.json ./out
// Never run in CI - it makes live network calls and needs real credentials.
//
// This has to be .ts run through tsx, not a plain .mjs run through node:
// node's native loader cannot resolve a bare .ts import (registry.ts below)
// at all, and --experimental-strip-types only looks like a fix because every
// import in this chain is currently `import type` and gets erased before the
// `@/*` alias would ever need resolving - the moment a module with a real
// value import lands in the registry, that approach breaks. tsx resolves
// TypeScript and honours the `@/*` -> `./src/*` mapping in tsconfig.json.
import { mkdir, writeFile } from 'node:fs/promises';
import { argv, exit } from 'node:process';

const [, , moduleId, configPath, outDir] = argv;
if (!moduleId || !configPath || !outDir) {
  console.error(
    'usage: npx tsx scripts/record-fixtures.ts <moduleId> <configJsonPath> <outDir>',
  );
  exit(1);
}

const config = JSON.parse(
  await (await import('node:fs/promises')).readFile(configPath, 'utf8'),
);
await mkdir(outDir, { recursive: true });

// The recorder wraps fetch so every response is captured in call order.
let call = 0;
const captured = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const response = await originalFetch(url, init);
  const body = await response.clone().json();
  captured.push({
    call: call++,
    url: String(url),
    status: response.status,
    body,
  });
  return response;
};

const { findModule } = await import('@/sources/registry');
const module = findModule(moduleId);
if (!module) {
  console.error(`no module '${moduleId}' in the registry`);
  exit(1);
}

// Every module implements probe() too, and a test file's mocked fetch
// commonly replays these same recorded fixtures for a probe() call as well
// as for fetchEvents - so record its request(s) up front, before draining
// pagination, rather than leaving probe's success path uncovered.
await module.probe(config);

// A failed drain is worth recording, not worth losing. fetchJson rejects on
// any non-ok status, so without this the 404 path - the one a contributor
// most needs to capture - produced no fixtures at all and no explanation.
let drainError;
try {
  let cursor = null;
  do {
    const page = await module.fetchEvents(config, cursor);
    cursor = page.cursor;
  } while (cursor !== null);
} catch (error) {
  drainError = error;
}

// Credentials must never reach a fixture file.
const secretFields = new Set(
  module.manifest.fields
    .filter((field) => field.type === 'apiKey' || field.type === 'secret')
    .map((field) => field.name),
);
const redact = (text) => {
  let out = text;
  for (const name of secretFields) {
    if (config[name]) {
      out = out.split(config[name]).join('<redacted>');
    }
  }
  return out;
};

for (const entry of captured) {
  await writeFile(
    `${outDir}/${String(entry.call).padStart(3, '0')}.json`,
    // The trailing newline is what Prettier wants, and these files are
    // committed: without it `npm run format:check` fails on every freshly
    // recorded fixture and the recording has to be reformatted by hand
    // before it can land.
    `${redact(JSON.stringify(entry, null, 2))}\n`,
  );
}
console.log(`wrote ${captured.length} fixture(s) to ${outDir}`);

if (drainError) {
  console.error(
    `drain failed after ${captured.length} captured response(s): ${drainError.message}`,
  );
}
