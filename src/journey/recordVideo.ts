/**
 * Wraps `MediaRecorder` behind one thin function. jsdom implements neither
 * `HTMLCanvasElement.captureStream` nor `MediaRecorder`, so this module's
 * real body never runs under test - `JourneyDialog` obtains the
 * `MediaStream` itself (via `canvas.captureStream()`, inside the component,
 * where a test can stub it) and hands it to `recordVideo`, which is mocked
 * wherever that matters. Keeping the captureStream() call OUTSIDE this
 * module, rather than taking a canvas here, is what lets a dialog test
 * assert "recordVideo was called with the stream the stubbed canvas
 * produced" without needing MediaRecorder to exist at all.
 */
export type RecordVideoOptions = {
  mimeType?: string;
};

const DEFAULT_MIME_TYPE = 'video/webm';

/**
 * Records `stream` for `durationMs`, then resolves with everything
 * `MediaRecorder` collected as one Blob.
 *
 * Rejects (with the original event/error attached as `cause`) if the
 * recorder itself reports an error, or if it cannot be constructed at all
 * (e.g. an unsupported mime type) - the caller is responsible for keeping
 * its dialog open and showing that message, the same way a failed series
 * build is handled.
 */
export const recordVideo = (
  stream: MediaStream,
  durationMs: number,
  options: RecordVideoOptions = {},
): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const mimeType = options.mimeType ?? DEFAULT_MIME_TYPE;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch (error) {
      reject(new Error('Could not start recording', { cause: error }));
      return;
    }

    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onerror = (event: Event) => {
      reject(new Error('Recording failed', { cause: event }));
    };
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: mimeType }));
    };

    recorder.start();
    setTimeout(() => {
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
    }, durationMs);
  });
