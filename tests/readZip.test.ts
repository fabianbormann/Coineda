import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import 'fake-indexeddb/auto';
import { looksLikeZip, readZip, NotAZipError } from '@/sources/csv/readZip';
import {
  EmptyArchiveError,
  importFile,
  textFromFile,
} from '@/sources/csv/importFile';
import { getAllEvents, getSources, openLedger } from '@/ledger/db';

/**
 * Reading the zip an exchange actually hands over.
 *
 * Kraken delivers a zip, not a bare CSV, so asking a person to unpack it
 * first is asking them to do work the app can do. The fixture is written by
 * Python's own zipfile - a real tool, DEFLATE, with a decoy file beside the
 * data - rather than bytes this implementation agrees with.
 */
let ZIP: Uint8Array;
let CSV: string;

beforeAll(async () => {
  const dir = path.join(__dirname, '../src/sources/kraken-csv/fixtures');
  ZIP = new Uint8Array(await readFile(path.join(dir, 'ledgers.zip')));
  CSV = await readFile(path.join(dir, 'ledgers.csv'), 'utf8');
});

const asFile = (bytes: Uint8Array | string, name: string) =>
  new File([bytes as BlobPart], name);

describe('recognising a zip', () => {
  it('knows one by its signature, not its name', async () => {
    // A user renames a download. The bytes are the only thing that cannot
    // be renamed.
    expect(looksLikeZip(ZIP)).toBe(true);
    expect(looksLikeZip(new TextEncoder().encode(CSV))).toBe(false);
    expect(looksLikeZip(new Uint8Array([1, 2]))).toBe(false);
  });

  it('finds the real directory past a fake signature in the data', async () => {
    // A zip's only fixed landmark sits at the END, and the four bytes that
    // mark it can appear inside a file's own content - this fixture stores
    // one deliberately, at byte 44, with the real record at 786. Scanning
    // forwards finds the decoy and misreads the whole archive.
    const trap = new Uint8Array(
      await readFile(
        path.join(
          __dirname,
          '../src/sources/kraken-csv/fixtures/eocd-trap.zip',
        ),
      ),
    );
    const entries = await readZip(trap);
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      'ledgers.csv',
      'trap.bin',
    ]);
    const ledger = entries.find((entry) => entry.name === 'ledgers.csv');
    expect(new TextDecoder().decode(ledger!.bytes)).toBe(CSV);
  });

  it('refuses something that is not an archive at all', async () => {
    await expect(
      readZip(new TextEncoder().encode('not a zip, just words')),
    ).rejects.toBeInstanceOf(NotAZipError);
  });
});

describe('unpacking', () => {
  it('inflates a real DEFLATE entry back to the original bytes', async () => {
    const entries = await readZip(ZIP);
    const ledger = entries.find((entry) => entry.name === 'ledgers.csv');
    expect(ledger).toBeDefined();
    expect(new TextDecoder().decode(ledger!.bytes)).toBe(CSV);
  });

  it('returns every entry, so the right one can be chosen later', async () => {
    const entries = await readZip(ZIP);
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      'ledgers.csv',
      'readme.txt',
    ]);
  });
});

describe('choosing the file inside', () => {
  it('picks the one an importer recognises, not the first', async () => {
    // readme.txt is written FIRST in the fixture. Picking by position
    // imports the readme and reports a header it cannot read.
    const text = await textFromFile(asFile(ZIP, 'kraken.zip'));
    expect(text).toBe(CSV);
  });

  it('takes a plain CSV straight through', async () => {
    // Someone who unpacked it themselves should not be told off for it.
    const text = await textFromFile(asFile(CSV, 'ledgers.csv'));
    expect(text).toBe(CSV);
  });

  it('names what was inside when nothing is readable', async () => {
    // Usually the wrong export, and the filenames say which - which beats
    // "bad file".
    const zip = new Uint8Array(
      await readFile(
        path.join(__dirname, '../src/sources/kraken-csv/fixtures/decoy.zip'),
      ),
    );
    await expect(textFromFile(asFile(zip, 'wrong.zip'))).rejects.toBeInstanceOf(
      EmptyArchiveError,
    );
    await expect(textFromFile(asFile(zip, 'wrong.zip'))).rejects.toThrow(
      /readme\.txt/,
    );
  });
});

describe('importing the zip end to end', () => {
  beforeEach(async () => {
    const db = await openLedger();
    for (const store of ['events', 'sources', 'cursors'] as const) {
      await db.clear(store);
    }
  });

  it('writes the same events as the unpacked file would', async () => {
    const fromZip = await importFile(
      await textFromFile(asFile(ZIP, 'kraken.zip')),
    );
    expect(fromZip.inserted).toBe(7);
    // Sorted: getAllEvents returns IndexedDB key order, and the keys are
    // random uuids - so an unsorted comparison fails on a shuffle rather
    // than on a difference.
    const afterZip = (await getAllEvents())
      .map((event) => event.externalId)
      .sort();

    const db = await openLedger();
    for (const store of ['events', 'sources', 'cursors'] as const) {
      await db.clear(store);
    }

    await importFile(await textFromFile(asFile(CSV, 'ledgers.csv')));
    expect(
      (await getAllEvents()).map((event) => event.externalId).sort(),
    ).toEqual(afterZip);
    expect(await getSources()).toHaveLength(1);
  });
});
