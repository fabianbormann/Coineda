import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import 'fake-indexeddb/auto';
import i18n from '@/i18n';
import { create as createQrCode } from 'qrcode';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { Toaster } from '@/components/ui/sonner';
import { OnboardingFlow } from '@/onboarding/OnboardingFlow';
import { decodeQrPayload } from '@/onboarding/ImportCheckpoint';
import { defaultsForLocale } from '@/onboarding/localeDefaults';
import { isOnboarded, getSettings } from '@/settings/settingsStore';
import { openLedger } from '@/ledger/db';
import {
  generateTransferSecret,
  sealCheckpoint,
  type Checkpoint,
} from '@/checkpoint/format';

// English on purpose: restoring a checkpoint now applies its language to
// i18n, so a German checkpoint here would flip every other assertion in
// this file to German. The German case has its own checkpoint below.
const emptyCheckpoint: Checkpoint = {
  v: 1,
  settings: { language: 'en', baseCurrency: 'eur' },
  sources: [],
  authoredEvents: [],
};

const germanCheckpoint: Checkpoint = {
  v: 1,
  settings: { language: 'de', baseCurrency: 'eur' },
  sources: [],
  authoredEvents: [],
};

// `sealCheckpoint`'s declared return type is the bare `Uint8Array`, which
// TS's DOM lib now treats as generic over its backing buffer
// (`Uint8Array<ArrayBufferLike>`) rather than the concrete `ArrayBuffer`
// `File`'s `BlobPart` union wants. Every byte sealed in this file always
// comes from a plain `new Uint8Array(...)`, never a SharedArrayBuffer, so
// this is a type-level cast, not a behavioural one.
const sealedToFile = (sealed: Uint8Array, name: string): File =>
  new File([sealed as Uint8Array<ArrayBuffer>], name);

/**
 * Rasterizes a QR code to the same `{ data, width, height }` shape
 * `decodeQrPayload` reads off a canvas, without a canvas: `qrcode`'s
 * `create()` returns the raw module bitmap synchronously, which this then
 * scales up and surrounds with a quiet zone (the >=4-module white border
 * real QR readers rely on to find the finder patterns) by hand. Byte-mode
 * segments, per QR_BYTE_LIMIT's own reasoning in src/checkpoint/channel.ts
 * - this is the same encoding a real device's QR would use to transmit a
 * sealed checkpoint's raw bytes, not a base64 string of them.
 */
const rasterizeQr = (
  bytes: Uint8Array,
): { data: Uint8ClampedArray; width: number; height: number } => {
  const qr = createQrCode([{ data: bytes, mode: 'byte' }], {
    errorCorrectionLevel: 'M',
  });
  const size = qr.modules.size;
  const quietZoneModules = 4;
  const scale = 4;
  const dimension = (size + quietZoneModules * 2) * scale;
  const data = new Uint8ClampedArray(dimension * dimension * 4).fill(255);

  for (let y = 0; y < dimension; y += 1) {
    for (let x = 0; x < dimension; x += 1) {
      const moduleX = Math.floor(x / scale) - quietZoneModules;
      const moduleY = Math.floor(y / scale) - quietZoneModules;
      const dark =
        moduleX >= 0 &&
        moduleX < size &&
        moduleY >= 0 &&
        moduleY < size &&
        qr.modules.get(moduleY, moduleX) !== 0;
      const value = dark ? 0 : 255;
      const index = (y * dimension + x) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
  }

  return { data, width: dimension, height: dimension };
};

beforeEach(async () => {
  const db = await openLedger();
  for (const store of ['events', 'sources', 'cursors', 'settings'] as const) {
    await db.clear(store);
  }
  vi.unstubAllGlobals();
  // A restore applies the checkpoint's language to the shared i18n
  // instance, which outlives the test - reset it so one test's restored
  // language cannot leak into the next one's assertions.
  await i18n.changeLanguage('en');
});

const renderFlow = (onComplete = vi.fn()) => {
  render(
    <ThemeProvider>
      <OnboardingFlow onComplete={onComplete} />
      <Toaster />
    </ThemeProvider>,
  );
  return onComplete;
};

describe('locale defaults', () => {
  it('maps a known locale to its language and currency', () => {
    expect(defaultsForLocale('de-DE')).toEqual({
      language: 'de',
      baseCurrency: 'eur',
    });
    expect(defaultsForLocale('en-US')).toEqual({
      language: 'en',
      baseCurrency: 'usd',
    });
  });

  it('falls back without throwing on a locale it has never seen', () => {
    // An unmapped locale must still produce a usable starting point the user
    // can then change, not a crash on first launch.
    expect(defaultsForLocale('xx-YY')).toEqual({
      language: 'en',
      baseCurrency: 'usd',
    });
  });
});

describe('starting fresh', () => {
  it('stores the confirmed language and currency and completes', async () => {
    const onComplete = renderFlow();
    await userEvent.click(
      await screen.findByRole('button', { name: /start fresh/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /confirm/i }),
    );

    await waitFor(async () => {
      expect(await isOnboarded()).toBe(true);
      expect(await getSettings()).toMatchObject({
        baseCurrency: expect.any(String),
      });
    });
    expect(onComplete).toHaveBeenCalled();
  });
});

describe('importing a checkpoint', () => {
  it('restores a real sealed checkpoint from a file and completes', async () => {
    // The happy path for the whole task's central feature: restoring a
    // checkpoint from another device onto this one. Nothing else in this
    // file drives a real checkpoint all the way through openCheckpoint ->
    // restoreCheckpoint to a success.
    const onComplete = renderFlow();
    const secret = generateTransferSecret();
    const sealed = await sealCheckpoint(emptyCheckpoint, secret);
    const file = sealedToFile(sealed, 'checkpoint.coineda');

    await userEvent.click(
      await screen.findByRole('button', { name: /have a checkpoint/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /from a file/i }),
    );
    await userEvent.upload(
      await screen.findByLabelText(/checkpoint file/i),
      file,
    );
    await userEvent.type(
      await screen.findByLabelText(/transfer secret/i),
      secret,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /restore/i }),
    );

    expect(await screen.findByText(/welcome back/i)).toBeInTheDocument();
    await waitFor(async () => {
      expect(await isOnboarded()).toBe(true);
    });
    expect(onComplete).toHaveBeenCalled();
  });

  it('applies the restored language, instead of storing it and staying in English', async () => {
    // Nothing reads settings.language back on boot, and this milestone
    // ships no settings screen, so a restore that only STORED the language
    // left a German user stuck in English with no way out. StartFresh
    // already calls i18n.changeLanguage for the language it was given;
    // restore has to do the same with the one it recovered.
    const secret = generateTransferSecret();
    const sealed = await sealCheckpoint(germanCheckpoint, secret);
    renderFlow();

    await userEvent.click(
      await screen.findByRole('button', { name: /have a checkpoint/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /from a file/i }),
    );
    await userEvent.upload(
      await screen.findByLabelText(/checkpoint file/i),
      sealedToFile(sealed, 'german.coineda'),
    );
    await userEvent.type(
      await screen.findByLabelText(/transfer secret/i),
      secret,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /restore/i }),
    );

    await waitFor(() => {
      expect(i18n.resolvedLanguage).toBe('de');
    });
    expect(await getSettings()).toMatchObject({ language: 'de' });
    // Applied to the live UI, not just stored: the screen the user is
    // looking at re-renders in German.
    expect(
      await screen.findByText(/Checkpoint wiederherstellen/i),
    ).toBeInTheDocument();
    // The confirmation itself is German too - the language is applied
    // before the toast is raised, so the first thing the user reads after
    // restoring is already in their own language. findAll because sonner
    // renders the title and its own aria-live copy of it.
    const toasts = await screen.findAllByText(/Checkpoint wiederhergestellt/i);
    expect(toasts.length).toBeGreaterThan(0);
  });

  it('reports a readable error when the chosen file cannot be read, instead of silently leaving Restore disabled', async () => {
    // A revoked blob or a device removed mid-read (mobile) makes
    // file.arrayBuffer() reject. Without a try/catch there, `payload` and
    // `formError` both stay unset and Restore stays disabled with no
    // explanation - the exact dead end this whole flow exists to avoid.
    renderFlow();
    await userEvent.click(
      await screen.findByRole('button', { name: /have a checkpoint/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /from a file/i }),
    );

    const file = new File([new Uint8Array([1, 2, 3])], 'c.coineda');
    vi.spyOn(file, 'arrayBuffer').mockRejectedValueOnce(
      new Error('device removed'),
    );

    await userEvent.upload(
      await screen.findByLabelText(/checkpoint file/i),
      file,
    );

    expect(await screen.findByText(/could not be opened/i)).toBeInTheDocument();
  });

  it('rejects a wrong transfer secret inline and stays un-onboarded', async () => {
    renderFlow();
    await userEvent.click(
      await screen.findByRole('button', { name: /have a checkpoint/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /from a file/i }),
    );

    const file = new File([new Uint8Array([1, 2, 3, 4])], 'c.coineda');
    await userEvent.upload(
      await screen.findByLabelText(/checkpoint file/i),
      file,
    );
    await userEvent.type(
      await screen.findByLabelText(/transfer secret/i),
      'BBBBBBBB',
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /restore/i }),
    );

    expect(await screen.findByText(/could not be opened/i)).toBeInTheDocument();
    expect(await isOnboarded()).toBe(false);
  });

  it('names the wrong secret specifically against a real sealed checkpoint', async () => {
    // The test above can only ever hit the generic "could not be opened"
    // branch: its 4-byte fixture is shorter than the 31-byte envelope
    // header, so `unseal` rejects it before any decryption is attempted,
    // regardless of what secret was typed. This one seals a real,
    // well-formed checkpoint with a KNOWN secret and then opens it with a
    // different one, so the failure actually comes from AES-GCM's own
    // auth-tag check (a native `OperationError`) - the one case
    // `describeOpenError` maps to the specific wrong-secret message.
    renderFlow();
    const sealed = await sealCheckpoint(emptyCheckpoint, 'AAAAAAAA');
    const file = sealedToFile(sealed, 'checkpoint.coineda');

    await userEvent.click(
      await screen.findByRole('button', { name: /have a checkpoint/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /from a file/i }),
    );
    await userEvent.upload(
      await screen.findByLabelText(/checkpoint file/i),
      file,
    );
    await userEvent.type(
      await screen.findByLabelText(/transfer secret/i),
      'BBBBBBBB',
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /restore/i }),
    );

    const message = await screen.findByText(/transfer secret is wrong/i);
    expect(message).toBeInTheDocument();
    expect(message.textContent).not.toMatch(/could not be opened/i);
    expect(await isOnboarded()).toBe(false);
  });

  it('names a newer format version specifically, against a real sealed checkpoint', async () => {
    // Same reasoning as the wrong-secret test above: this has to be a real,
    // correctly-sealed envelope (right secret, right header) so the
    // failure comes from openCheckpoint's own version check, not the
    // envelope-level "not a Coineda checkpoint" guard the first test hits.
    renderFlow();
    const secret = generateTransferSecret();
    const sealed = await sealCheckpoint(
      { ...emptyCheckpoint, v: 2 as 1 },
      secret,
    );
    const file = sealedToFile(sealed, 'checkpoint.coineda');

    await userEvent.click(
      await screen.findByRole('button', { name: /have a checkpoint/i }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /from a file/i }),
    );
    await userEvent.upload(
      await screen.findByLabelText(/checkpoint file/i),
      file,
    );
    await userEvent.type(
      await screen.findByLabelText(/transfer secret/i),
      secret,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /restore/i }),
    );

    const message = await screen.findByText(/newer version/i);
    expect(message).toBeInTheDocument();
    expect(message.textContent).not.toMatch(/could not be opened/i);
    expect(await isOnboarded()).toBe(false);
  });

  it('offers the file picker when camera permission is denied', async () => {
    // Dead-ending on a denied camera would strand the user in onboarding.
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn().mockRejectedValue(new Error('NotAllowedError')),
      },
    });
    renderFlow();
    await userEvent.click(
      await screen.findByRole('button', { name: /have a checkpoint/i }),
    );
    await userEvent.click(await screen.findByRole('button', { name: /scan/i }));

    expect(await screen.findByText(/camera/i)).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /from a file/i }),
    ).toBeInTheDocument();
  });

  it('stops a camera stream that only arrives after the component has unmounted', async () => {
    // A user can hit Back (or finish onboarding some other way) while the
    // browser's permission prompt is still open - getUserMedia() doesn't
    // resolve until they answer it. Without a cancelled guard, the stream
    // that eventually arrives would never get stopped (nothing left to
    // call stopCamera()) and scanFrame would reschedule itself via
    // requestAnimationFrame forever, against refs that are already null.
    const stopTrack = vi.fn();
    const stream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    let resolveGetUserMedia: (stream: MediaStream) => void = () => {};
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveGetUserMedia = resolve;
        }),
    );
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia },
    });

    const { unmount } = render(
      <ThemeProvider>
        <OnboardingFlow onComplete={vi.fn()} />
        <Toaster />
      </ThemeProvider>,
    );

    await userEvent.click(
      await screen.findByRole('button', { name: /have a checkpoint/i }),
    );
    await userEvent.click(await screen.findByRole('button', { name: /scan/i }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());

    unmount();
    resolveGetUserMedia(stream);

    await vi.waitFor(() => expect(stopTrack).toHaveBeenCalled());
  });
});

describe('decoding a scanned QR frame', () => {
  it('recovers the exact bytes that were encoded, round-tripped through a real QR bitmap', () => {
    // decodeQrPayload is the sole conversion from scanned pixels to the
    // sealed payload for the whole QR path. A bug here would not crash -
    // scanFrame would just never decode and loop forever via
    // requestAnimationFrame, silently stranding a user on what the flow
    // presents as the primary restore route. This renders a real sealed
    // checkpoint to a real QR bitmap (byte-mode segments, never base64 -
    // see QR_BYTE_LIMIT's reasoning in src/checkpoint/channel.ts) and
    // proves the decoded bytes are identical to what was sealed.
    const sealed = new Uint8Array(180);
    for (let i = 0; i < sealed.length; i += 1) {
      sealed[i] = (i * 37 + 11) % 256;
    }

    const imageData = rasterizeQr(sealed);
    const decoded = decodeQrPayload(imageData);

    expect(decoded).not.toBeNull();
    expect(Array.from(decoded ?? [])).toEqual(Array.from(sealed));
  });

  it('returns null, rather than throwing, on an image with no QR code in it', () => {
    const blank = {
      data: new Uint8ClampedArray(100 * 100 * 4).fill(255),
      width: 100,
      height: 100,
    };
    expect(decodeQrPayload(blank)).toBeNull();
  });
});
