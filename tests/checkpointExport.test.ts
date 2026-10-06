import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import {
  buildCheckpoint,
  sealCheckpoint,
  openCheckpoint,
  chooseChannel,
  encodeQrPayload,
  generateTransferSecret,
  QR_BYTE_LIMIT,
  restoreCheckpoint,
} from '@/checkpoint/format';
import {
  getLinkedEvents,
  getManualLinks,
  putManualLink,
} from '@/ledger/manualLinks';
import { putSettings } from '@/settings/settingsStore';
import { getAllEvents, openLedger, putSource, putEvents } from '@/ledger/db';
import type { LedgerEvent } from '@/ledger/types';

/**
 * Renders a byte-mode QR to raw RGBA without a canvas.
 *
 * jsdom has no 2D canvas, so the production path's PNG data URL cannot be
 * decoded back in a test. QRCode.create exposes the module bitmap directly,
 * which is all jsQR needs - and it goes through the SAME segment encoding the
 * production call uses, so a byte-mode/text-mode mismatch still shows up here.
 */
const renderToImageData = (bytes: Uint8Array) => {
  const scale = 4;
  const quiet = 4;
  const qr = QRCode.create([{ data: bytes, mode: 'byte' }], {
    errorCorrectionLevel: 'M',
  });
  const size = qr.modules.size;
  const dim = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);
  for (let y = 0; y < dim; y += 1) {
    for (let x = 0; x < dim; x += 1) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      const dark =
        mx >= 0 &&
        my >= 0 &&
        mx < size &&
        my < size &&
        qr.modules.data[my * size + mx] === 1;
      const value = dark ? 0 : 255;
      const i = (y * dim + x) * 4;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return { data, width: dim, height: dim };
};

const authoredEvent = (n: number): LedgerEvent => ({
  id: `authored-${n}`,
  sourceId: 'manual',
  externalId: `manual-${n}`,
  timestamp: 1_700_000_000_000 + n,
  kind: 'transfer',
  origin: 'authored',
  legs: [
    {
      assetId: 'cardano:lovelace',
      amount: '1000000',
      direction: 'in',
      venue: 'addr_test1_mine',
      role: 'principal',
    },
  ],
});

// Deliberately not `indexedDB.deleteDatabase('coineda-v2')`, as the task
// brief originally specified: openLedger() memoises its connection at
// module-import time and never closes it, so a delete issued against an
// open connection is a no-op in fake-indexeddb just as it would be in a
// real browser (see the "v1 to current schema upgrade" test in
// tests/prices.test.ts, which documents the same caveat and explicitly
// closes the connection first). Verified experimentally: with
// deleteDatabase alone, the 400 authored events from "routes an oversized
// checkpoint..." below bled into the next test's assertions. Clearing every
// store on the already-open connection - the same pattern
// tests/checkpoint.test.ts uses - gets genuine per-test isolation without
// fighting the memoised connection.
beforeEach(async () => {
  const db = await openLedger();
  for (const store of [
    'events',
    'sources',
    'cursors',
    'settings',
    'transferLinks',
  ] as const) {
    await db.clear(store);
  }
  await putSettings({ language: 'en', baseCurrency: 'eur' });
});

describe('checkpoint export', () => {
  it('round-trips through the QR channel the import side actually reads', async () => {
    // The one test that would have caught a base64-vs-bytes mismatch: it
    // encodes with the production encoder's segment shape and decodes with
    // the production decoder's library, then opens the result for real.
    await putSettings({ language: 'de', baseCurrency: 'usd' });
    await putSource({
      id: 'src-1',
      moduleId: 'cardano-yaci',
      label: 'My wallet',
      config: { address: 'addr_test1_mine' },
    });

    const checkpoint = await buildCheckpoint();
    const secret = generateTransferSecret();
    const sealed = await sealCheckpoint(checkpoint, secret);

    expect(chooseChannel(sealed).channel).toBe('qr');

    const decoded = jsQR(
      renderToImageData(sealed).data,
      renderToImageData(sealed).width,
      renderToImageData(sealed).height,
    );
    expect(decoded).not.toBeNull();

    const reopened = await openCheckpoint(
      new Uint8Array(decoded!.binaryData),
      secret,
    );
    expect(reopened).toEqual(checkpoint);
  });

  it('produces a data URL the dialog can render', async () => {
    const sealed = await sealCheckpoint(
      await buildCheckpoint(),
      generateTransferSecret(),
    );
    const url = await encodeQrPayload(sealed);
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('seals with the generated secret and nothing else opens it', async () => {
    // Not a substring search for the secret in the ciphertext: deflate alone
    // would destroy that substring, so such a test passes against an
    // implementation that never encrypted anything. This asserts the property
    // that actually matters - the bytes are useless without the secret.
    const checkpoint = await buildCheckpoint();
    const secret = generateTransferSecret();
    const sealed = await sealCheckpoint(checkpoint, secret);

    await expect(openCheckpoint(sealed, secret)).resolves.toEqual(checkpoint);
    await expect(
      openCheckpoint(sealed, generateTransferSecret()),
    ).rejects.toThrow();
  });

  it('measures a realistic checkpoint against the QR limit', async () => {
    // Evidence for the single-frame ruling in this task's header, not a
    // behavioural assertion: three sources and no authored history is the
    // shape this app is built around, and it must fit one code comfortably.
    for (let n = 0; n < 3; n += 1) {
      await putSource({
        id: `src-${n}`,
        moduleId: 'cardano-yaci',
        label: `Wallet ${n}`,
        config: {
          address: `addr_test1qrfevesruxmael3rc44d27s08xzud9ph9f0lytr7mxc8lpejdmtq36xfp696zs34qpfnuw356nhwvwdr8pzk5npd496syz6knm${n}`,
          baseUrl: 'https://yaci-store.mainnet.colo2.cf-systems.org',
        },
      });
    }
    const sealed = await sealCheckpoint(
      await buildCheckpoint(),
      generateTransferSecret(),
    );
    console.log(
      `realistic checkpoint: ${sealed.byteLength} bytes of ${QR_BYTE_LIMIT}`,
    );
    expect(sealed.byteLength).toBeLessThan(QR_BYTE_LIMIT / 2);
  });

  it('routes an oversized checkpoint to the file channel instead of truncating', async () => {
    // Events are the unbounded part of a checkpoint, and now that synced
    // ones travel too, most real checkpoints are files. Enough of them
    // must switch channel, never silently produce a QR that scans back
    // into a partial setup looking complete.
    await putEvents(Array.from({ length: 400 }, (_, n) => authoredEvent(n)));
    const sealed = await sealCheckpoint(
      await buildCheckpoint(),
      generateTransferSecret(),
    );
    expect(sealed.byteLength).toBeGreaterThan(QR_BYTE_LIMIT);
    expect(chooseChannel(sealed).channel).toBe('file');
  });

  it('carries synced events too, each in its own list', async () => {
    // Synced events used to be left out, on the reasoning that they reload
    // from their sources. They do - while the source exists. An exchange
    // that shuts down takes the history with it, and in a tax tool the
    // history IS the asset: a disposal's cost basis comes from an
    // acquisition years earlier. So a checkpoint is a backup, not only a
    // handover.
    //
    // Two lists rather than one, and asserted as two: an older build
    // reads `authoredEvents` and must still find exactly what it knows
    // there, with nothing of the other kind mixed in.
    await putEvents([
      authoredEvent(1),
      { ...authoredEvent(2), id: 'derived-1', origin: 'derived' },
    ]);
    const checkpoint = await buildCheckpoint();

    expect(checkpoint.authoredEvents.map((e) => e.id)).toEqual(['authored-1']);
    expect(checkpoint.derivedEvents?.map((e) => e.id)).toEqual(['derived-1']);
  });

  it('survives the source it came from disappearing', async () => {
    // THE case this change exists for. Kraken shuts down, the API key is
    // revoked, a provider drops an endpoint - the source cannot be synced
    // again, and what the checkpoint carries is all there is.
    await putSource({
      id: 'kraken',
      moduleId: 'kraken-csv',
      label: 'Kraken',
      config: {},
    });
    await putEvents([
      {
        ...authoredEvent(7),
        id: 'kraken-1',
        sourceId: 'kraken',
        origin: 'derived',
      },
    ]);

    const secret = generateTransferSecret();
    const sealed = await sealCheckpoint(await buildCheckpoint(), secret);

    // The device is wiped: no events, no sources, nothing to sync from.
    const db = await openLedger();
    await db.clear('events');
    await db.clear('sources');

    await restoreCheckpoint(await openCheckpoint(sealed, secret));

    const restored = await getAllEvents();
    expect(restored.map((event) => event.id)).toEqual(['kraken-1']);
    expect(restored[0].legs[0].amount).toBe('1000000');
  });

  it("leaves this device's sync state out of the checkpoint", async () => {
    // lastSyncedAt and lastError describe one device's sync history, not the
    // portable configuration. Carried across, a freshly restored device
    // with zero synced events would show "Last synced <yesterday>" plus
    // whatever error the other device happened to be sitting on.
    await putSource({
      id: 'src-1',
      moduleId: 'cardano-yaci',
      label: 'My wallet',
      config: { address: 'addr_test1_mine' },
      lastSyncedAt: 1_700_000_000_000,
      lastError: 'provider refused the request',
    });

    const checkpoint = await buildCheckpoint();

    expect(checkpoint.sources).toHaveLength(1);
    const [source] = checkpoint.sources;
    expect(source.lastSyncedAt).toBeUndefined();
    expect(source.lastError).toBeUndefined();
    // Absent, not merely undefined: the keys must not travel at all.
    expect(Object.keys(source).sort()).toEqual([
      'config',
      'id',
      'label',
      'moduleId',
    ]);
    // Everything that IS portable still travels.
    expect(source).toMatchObject({
      id: 'src-1',
      moduleId: 'cardano-yaci',
      label: 'My wallet',
      config: { address: 'addr_test1_mine' },
    });
  });

  it('refuses to build a checkpoint before onboarding has run', async () => {
    // The beforeEach above always seeds settings, so this test clears just
    // that store back out rather than relying on deleteDatabase - see the
    // comment on the beforeEach for why that call would not actually do
    // anything here.
    const db = await openLedger();
    await db.clear('settings');
    await expect(buildCheckpoint()).rejects.toThrow(/onboarding/);
  });
});

/**
 * Transfers the user confirmed by hand have to travel with a checkpoint.
 *
 * They are a judgement no sync reproduces: the exchange's export never
 * carried the chain hash, which is why the person had to supply it. Left
 * out, a restored device shows the same withdrawals as disposals again,
 * and a tax report run there disagrees with the one run here - for a
 * reason nothing on screen would explain.
 */
describe('confirmed transfers in a checkpoint', () => {
  const link = {
    sourceId: 'kraken',
    externalId: 'LLSN5F-UR5OY-DD6KMV',
    txHash: 'a1b2'.repeat(16),
    confirmedAt: 1_740_000_000_000,
  };

  it('carries them, and restores them on the other device', async () => {
    await putManualLink(link);

    const secret = generateTransferSecret();
    const sealed = await sealCheckpoint(await buildCheckpoint(), secret);
    const reopened = await openCheckpoint(sealed, secret);
    expect(reopened.transferLinks).toEqual([link]);

    // Restored into an empty store, the way the other device would be.
    await (await openLedger()).clear('transferLinks');
    expect(await getManualLinks()).toEqual([]);

    await restoreCheckpoint(reopened);
    expect(await getManualLinks()).toEqual([link]);
  });

  it('applies a restored confirmation to the event it belongs to', async () => {
    // The whole point: the hash has to land on the ledger row, or the
    // restored link is a stored row that changes nothing.
    await putEvents([
      {
        id: 'kraken-in',
        sourceId: 'kraken',
        externalId: 'LLSN5F-UR5OY-DD6KMV',
        timestamp: 1_740_000_000_000,
        kind: 'transfer',
        origin: 'derived',
        legs: [
          {
            assetId: 'bitcoin:native',
            amount: '7545306',
            direction: 'in',
            venue: 'kraken',
            role: 'principal',
          },
        ],
      },
    ]);
    expect((await getLinkedEvents())[0].txHash).toBeUndefined();

    await restoreCheckpoint({
      v: 1,
      settings: { language: 'en', baseCurrency: 'eur' },
      sources: [],
      authoredEvents: [],
      transferLinks: [link],
    });

    expect((await getLinkedEvents())[0].txHash).toBe(link.txHash);
  });

  it('accepts a checkpoint written before the field existed', async () => {
    // An older export has no `transferLinks` at all. Refusing it would
    // cost the user their settings and credentials to save them one
    // re-confirmation.
    const secret = generateTransferSecret();
    const checkpoint = await buildCheckpoint();
    delete (checkpoint as { transferLinks?: unknown }).transferLinks;
    const sealed = await sealCheckpoint(checkpoint, secret);

    const reopened = await openCheckpoint(sealed, secret);
    expect(reopened.transferLinks).toBeUndefined();
    await expect(restoreCheckpoint(reopened)).resolves.toBeUndefined();
  });

  it('refuses a link that would store cleanly and never apply', async () => {
    // Validated BEFORE the transaction opens, like authored events, so a
    // bad payload cannot leave a half-restored install behind.
    await expect(
      restoreCheckpoint({
        v: 1,
        settings: { language: 'en', baseCurrency: 'eur' },
        sources: [],
        authoredEvents: [],
        transferLinks: [{ ...link, txHash: '' }],
      }),
    ).rejects.toThrow(/txHash/);
    expect(await getManualLinks()).toEqual([]);
  });

  it('refuses a payload whose synced events are not a list', async () => {
    // Without the shape check this reaches the restore's spread as a
    // string and fails there instead - safely, but with an error about a
    // leg rather than about a malformed checkpoint.
    const secret = generateTransferSecret();
    const checkpoint = await buildCheckpoint();
    (checkpoint as { derivedEvents?: unknown }).derivedEvents = 'nope';
    const sealed = await sealCheckpoint(checkpoint, secret);

    await expect(openCheckpoint(sealed, secret)).rejects.toThrow(
      /unexpected shape/i,
    );
  });

  it('refuses a payload whose links are not a list', async () => {
    const secret = generateTransferSecret();
    const checkpoint = await buildCheckpoint();
    (checkpoint as { transferLinks?: unknown }).transferLinks = 'nope';
    const sealed = await sealCheckpoint(checkpoint, secret);

    await expect(openCheckpoint(sealed, secret)).rejects.toThrow(
      /unexpected shape/i,
    );
  });
});

/**
 * Two scopes, because a checkpoint answers two different questions.
 *
 * A handover sets up a device standing in front of you and has to fit a
 * single QR code; a backup outlives the sources it came from and cannot.
 * Pretending one is a degraded version of the other is what hid, from the
 * person scanning, that the history was being left behind.
 */
describe('what each scope carries', () => {
  const synced = (n: number): LedgerEvent => ({
    ...authoredEvent(n),
    id: `synced-${n}`,
    externalId: `synced-${n}`,
    sourceId: 'kraken',
    origin: 'derived',
  });

  beforeEach(async () => {
    await putSource({
      id: 'kraken',
      moduleId: 'kraken-csv',
      label: 'Kraken',
      config: {},
    });
    await putManualLink({
      sourceId: 'kraken',
      externalId: 'LLSN5F-UR5OY-DD6KMV',
      txHash: 'a1b2'.repeat(16),
    });
    await putEvents([
      authoredEvent(1),
      ...Array.from({ length: 5 }, (_, n) => synced(n)),
    ]);
  });

  it('leaves the ledger out of a handover and states its size instead', async () => {
    const handover = await buildCheckpoint('handover');

    expect(handover.derivedEvents).toBeUndefined();
    expect(handover.omittedEventCount).toBe(5);
    // Everything no sync reproduces still travels - that is the whole
    // point of a handover, as against "just the settings".
    expect(handover.authoredEvents.map((e) => e.id)).toEqual(['authored-1']);
    expect(handover.transferLinks).toHaveLength(1);
    expect(handover.sources).toHaveLength(1);
  });

  it('puts the ledger in a backup and claims nothing missing', async () => {
    const backup = await buildCheckpoint('backup');

    expect(backup.derivedEvents).toHaveLength(5);
    // Never both: a payload that carries the events AND says it omitted
    // them would have the receiving device explain a gap that is not there.
    expect(backup.omittedEventCount).toBeUndefined();
  });

  it('defaults to a backup, so a caller that forgets loses nothing', async () => {
    expect((await buildCheckpoint()).derivedEvents).toHaveLength(5);
  });

  it('round-trips a handover through the QR channel it is sized for', async () => {
    const secret = generateTransferSecret();
    const sealed = await sealCheckpoint(
      await buildCheckpoint('handover'),
      secret,
    );

    expect(chooseChannel(sealed).channel).toBe('qr');
    const reopened = await openCheckpoint(sealed, secret);
    expect(reopened.omittedEventCount).toBe(5);
  });

  it('refuses a payload whose omitted count is not a number', async () => {
    const secret = generateTransferSecret();
    const checkpoint = await buildCheckpoint('handover');
    (checkpoint as { omittedEventCount?: unknown }).omittedEventCount = 'five';
    const sealed = await sealCheckpoint(checkpoint, secret);

    await expect(openCheckpoint(sealed, secret)).rejects.toThrow(
      /unexpected shape/i,
    );
  });
});
