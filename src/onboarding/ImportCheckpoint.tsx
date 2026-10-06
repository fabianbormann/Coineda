import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import jsQR from 'jsqr';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { notify } from '@/lib/notify';
import { openCheckpoint, restoreCheckpoint } from '@/checkpoint/format';

type Props = {
  onComplete: () => void;
  onBack: () => void;
};

type Step = 'choice' | 'scan' | 'file' | 'restored';

/**
 * `openCheckpoint` throws three distinct failures - a newer format version,
 * a shape that doesn't look like a `Checkpoint` after decrypting, and (via
 * Web Crypto, when `unseal`'s AES-GCM tag check fails) a native
 * `OperationError` for a wrong secret - plus a couple of header-level
 * throws from `unseal` itself ("not a Coineda checkpoint", "unsupported
 * checkpoint format") for bytes that are not this envelope at all. None of
 * those are presentable to a user as-is, and a raw stack trace must never
 * reach the form. This maps all of them to exactly three translated,
 * static messages: a specific one for "you typed the secret wrong", a
 * specific one for "update the app first", and one shared message for
 * every other way a checkpoint can fail to open (malformed shape, not a
 * Coineda checkpoint, unsupported format, or anything else unexpected).
 */
const describeOpenError = (error: unknown, t: TFunction): string => {
  // Not `error instanceof DOMException`: under jsdom (this app's own test
  // environment), Web Crypto's AES-GCM failure is thrown as Node's own
  // DOMException, a different realm's class than jsdom's global
  // `DOMException` - `instanceof` across that boundary is false even
  // though `error.name` reads 'OperationError' either way. Checking the
  // name directly against the (specced, stable) `Error` base works in
  // every environment this app ships in, not just the one it's thrown in
  // natively.
  if (error instanceof Error && error.name === 'OperationError') {
    return t('That transfer secret is wrong. Check it and try again.');
  }
  const message = error instanceof Error ? error.message : '';
  if (/newer version/i.test(message)) {
    return t(
      'This checkpoint was made with a newer version of Coineda. Update the app, then try restoring it again.',
    );
  }
  return t(
    "This checkpoint could not be opened. The file may be corrupted or isn't a valid Coineda checkpoint.",
  );
};

/**
 * Pulled out from the scan loop so it can be exercised directly in tests
 * without driving a camera: handed an ImageData-shaped object, it either
 * returns the decoded bytes or null. Uses jsQR's `binaryData` (raw byte
 * values), never `data` - `data` is jsQR's attempt to read the bytes as
 * UTF-8 text, which would corrupt an encrypted, non-UTF-8 checkpoint.
 */
export const decodeQrPayload = (imageData: {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}): Uint8Array | null => {
  const result = jsQR(imageData.data, imageData.width, imageData.height);
  if (!result) {
    return null;
  }
  return new Uint8Array(result.binaryData);
};

export const ImportCheckpoint = ({ onComplete, onBack }: Props) => {
  const { t, i18n } = useTranslation();
  const [step, setStep] = useState<Step>('choice');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [payload, setPayload] = useState<Uint8Array | null>(null);
  const [secret, setSecret] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /**
   * Recorded transactions the restored checkpoint deliberately left out,
   * which is what a handover does.
   *
   * Drives the step after a successful restore. A handover is complete in
   * its own terms - settings, sources, confirmations, everything no sync
   * reproduces - but a person who restored one and landed straight on an
   * empty overview has no way to tell that from a broken import. So when
   * the number is above zero, the restore explains itself before handing
   * over.
   */
  const [omitted, setOmitted] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  // Set by the unmount cleanup below and checked after every `await` in
  // `startScan`, before that continuation touches a ref or schedules a
  // frame. `getUserMedia()`'s permission prompt can stay pending for as
  // long as the user leaves it open - if they hit Back while it is still
  // pending, the component is gone before the promise ever settles, so
  // there is no cleanup left to run when it finally does. Without this
  // flag the resolved stream would be assigned to `streamRef` with nobody
  // ever calling `stopCamera()` on it (the camera light stays on forever),
  // and `scanFrame` would find its own refs null, hit its own guard, and
  // keep rescheduling itself via `requestAnimationFrame` forever.
  const cancelledRef = useRef(false);

  const stopCamera = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  // Release the camera whenever this component goes away, not only on an
  // explicit cancel - a user navigating Back must not leave the camera
  // light on.
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      stopCamera();
    };
  }, [stopCamera]);

  // A plain hoisted function declaration, not a `useCallback` - it has to
  // call itself recursively via `requestAnimationFrame`, and a `const`
  // bound to a hook's return value is still in scope but not yet assigned
  // at the point such a self-call would need it.
  function scanFrame() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < video.HAVE_ENOUGH_DATA) {
      frameRef.current = requestAnimationFrame(scanFrame);
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      frameRef.current = requestAnimationFrame(scanFrame);
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const decoded = decodeQrPayload(imageData);
    if (decoded) {
      stopCamera();
      setPayload(decoded);
      return;
    }
    frameRef.current = requestAnimationFrame(scanFrame);
  }

  const startScan = async () => {
    setStep('scan');
    setCameraError(null);
    setFormError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('camera unavailable');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
      });
      if (cancelledRef.current) {
        // Unmounted while the permission prompt was open - this stream
        // never got assigned to `streamRef`, so `stopCamera()` never saw
        // it and never stopped it. Stop it here instead, and do nothing
        // else: there is no video element and no scan loop left to use it.
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      if (cancelledRef.current) {
        // Unmounted while `play()` was pending. `stopCamera()` already ran
        // on unmount, but against whatever `streamRef` held at that
        // moment - which could have been this same stream (then correctly
        // stopped already) or, if unmount raced ahead of the assignment
        // above, nothing. Stopping again here is a harmless no-op in the
        // first case and the only release in the second.
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        return;
      }
      frameRef.current = requestAnimationFrame(scanFrame);
    } catch {
      // Never a dead end: a denied or missing camera still has to leave the
      // user able to finish onboarding, just by a different route. But if
      // the component is already gone, there is no form left to show that
      // message on.
      if (!cancelledRef.current) {
        setCameraError(
          t(
            'Camera access was denied or the camera is unavailable. Use a file instead.',
          ),
        );
      }
    }
  };

  const switchToFile = () => {
    stopCamera();
    setCameraError(null);
    setStep('file');
  };

  const handleFileChosen = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setFormError(null);
    try {
      setPayload(new Uint8Array(await file.arrayBuffer()));
    } catch {
      // A rejected read (a revoked blob, a device removed mid-read) must
      // not leave the Restore button silently disabled with no
      // explanation - that is exactly the dead end this flow exists to
      // avoid. Same generic message as an unopenable checkpoint: from the
      // user's side, a file that cannot be read is indistinguishable from
      // one that cannot be opened.
      setPayload(null);
      setFormError(
        t(
          "This checkpoint could not be opened. The file may be corrupted or isn't a valid Coineda checkpoint.",
        ),
      );
    }
  };

  const handleRestore = async () => {
    if (!payload) {
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      // restoreCheckpoint owns setting `onboarded` - it does so last, inside
      // its own atomic transaction, so any failure anywhere in this
      // sequence leaves the install un-onboarded rather than half-applied.
      const checkpoint = await openCheckpoint(payload, secret);
      await restoreCheckpoint(checkpoint);
      // Apply the restored language, the same way StartFresh applies the
      // chosen one. Nothing reads settings.language back on boot and this
      // milestone ships no settings screen, so a restore that only stored
      // it would leave a German user's UI in English with no way to change
      // it. Done before the confirmation toast so the first thing they
      // read after restoring is already in their language.
      //
      // Guarded on the value actually being a language tag: openCheckpoint
      // validates that `settings` is an object, not what is inside it, and
      // changeLanguage(undefined) re-runs browser detection instead of
      // leaving the current language alone.
      if (
        typeof checkpoint.settings?.language === 'string' &&
        checkpoint.settings.language.length > 0
      ) {
        await i18n.changeLanguage(checkpoint.settings.language);
      }
      // `i18n.t`, not the `t` from useTranslation: react-i18next binds that
      // `t` to the language of the render it came from, so it would still
      // return English here even though i18n has already switched. The
      // toast is raised imperatively from an event handler rather than
      // rendered, so it cannot wait for the re-render that would give it a
      // fresh `t` - and the confirmation of a restore is the one string
      // that should definitely already be in the restored language.
      notify.success(i18n.t('Checkpoint restored. Welcome back!'));
      const missing = checkpoint.omittedEventCount ?? 0;
      if (missing > 0) {
        setOmitted(missing);
        setStep('restored');
        return;
      }
      onComplete();
    } catch (error) {
      setFormError(describeOpenError(error, t));
    } finally {
      setSubmitting(false);
    }
  };

  if (step === 'restored') {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('Almost everything is here')}</CardTitle>
          <CardDescription>
            {t(
              'Your settings, your data sources and anything you entered yourself came across.',
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <p>
            {t(
              'What did not fit the code: {{count}} recorded transactions. There are two ways to get them here.',
              { count: omitted },
            )}
          </p>
          <div className="flex flex-col gap-1">
            <h3 className="font-medium">{t('Let your sources refetch it')}</h3>
            <p className="text-muted-foreground">
              {t(
                'Your data sources came across with their credentials, so a sync on this device fetches the history again by itself. This is the ordinary way, and it needs nothing from your other device.',
              )}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="font-medium">{t('Or bring a backup file over')}</h3>
            <p className="text-muted-foreground">
              {t(
                'For a source that cannot be synced any more - an exchange that closed, an API key that is gone, a file import - create a checkpoint on your other device, download it as a file, and import that file here. It carries every recorded transaction.',
              )}
            </p>
          </div>
        </CardContent>
        <CardFooter>
          <Button type="button" onClick={onComplete}>
            {t('Got it')}
          </Button>
        </CardFooter>
      </Card>
    );
  }

  if (step === 'scan') {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('Restore a checkpoint')}</CardTitle>
          {!cameraError && (
            <CardDescription>
              {t(
                'Point your camera at the QR code shown on your other device.',
              )}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {cameraError ? (
            <p className="text-sm text-destructive" role="alert">
              {cameraError}
            </p>
          ) : (
            <video
              ref={videoRef}
              className="aspect-square w-full rounded-md bg-muted"
              muted
              playsInline
            />
          )}
          <canvas ref={canvasRef} className="hidden" />
          {payload && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="transfer-secret-scan">
                {t('Transfer secret')}
              </Label>
              <Input
                id="transfer-secret-scan"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder={t(
                  'Enter the 8-character transfer secret shown on your other device.',
                )}
              />
              {formError && (
                <p className="text-sm text-destructive" role="alert">
                  {formError}
                </p>
              )}
            </div>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          {cameraError ? (
            <Button type="button" onClick={switchToFile}>
              {t('From a file')}
            </Button>
          ) : (
            payload && (
              <Button
                type="button"
                onClick={handleRestore}
                disabled={submitting}
              >
                {t('Restore')}
              </Button>
            )
          )}
          <Button type="button" variant="ghost" onClick={onBack}>
            {t('Back')}
          </Button>
        </CardFooter>
      </Card>
    );
  }

  if (step === 'file') {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('Restore a checkpoint')}</CardTitle>
          <CardDescription>
            {t(
              'Scan the QR code shown on your other device, or choose the checkpoint file it saved instead.',
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="checkpoint-file">{t('Checkpoint file')}</Label>
            <Input
              id="checkpoint-file"
              type="file"
              accept=".coineda"
              onChange={handleFileChosen}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="transfer-secret-file">{t('Transfer secret')}</Label>
            <Input
              id="transfer-secret-file"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder={t(
                'Enter the 8-character transfer secret shown on your other device.',
              )}
            />
          </div>
          {formError && (
            <p className="text-sm text-destructive" role="alert">
              {formError}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={handleRestore}
            disabled={submitting || !payload}
          >
            {t('Restore')}
          </Button>
          <Button type="button" variant="ghost" onClick={onBack}>
            {t('Back')}
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{t('Restore a checkpoint')}</CardTitle>
        <CardDescription>
          {t(
            'Scan the QR code shown on your other device, or choose the checkpoint file it saved instead.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button type="button" onClick={startScan}>
          {t('Scan')}
        </Button>
        <Button type="button" variant="outline" onClick={switchToFile}>
          {t('From a file')}
        </Button>
      </CardContent>
      <CardFooter>
        <Button type="button" variant="ghost" onClick={onBack}>
          {t('Back')}
        </Button>
      </CardFooter>
    </Card>
  );
};
