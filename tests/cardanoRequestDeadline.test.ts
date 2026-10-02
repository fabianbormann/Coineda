import { describe, it, expect, vi, afterEach } from 'vitest';
import cardanoYaci from '@/sources/cardano-yaci';
import { REQUEST_TIMEOUT_MS } from '@/sources/cardano/http';
import { CARDANO_MESSAGES } from '@/sources/cardano/messages';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const config = { baseUrl: 'https://yaci.example.org', address: 'addr_test1_x' };

describe('every provider request carries a deadline', () => {
  it('asks for a timeout signal of exactly the module deadline', async () => {
    // The gap this file exists to close. The pre-existing test asserted only
    // that the signal handed to fetch is `instanceof AbortSignal`, which a
    // CALLER-supplied signal satisfies - so deleting the timeout entirely
    // left all 418 tests green. Observing the AbortSignal.timeout call is
    // what makes the deadline itself load-bearing.
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[]', { status: 200 })),
    );

    await cardanoYaci.fetchEvents(config, null);

    expect(timeout).toHaveBeenCalled();
    expect(timeout.mock.calls.map((call) => call[0])).toContain(
      REQUEST_TIMEOUT_MS,
    );
  });

  it('is 20 seconds, the value the reported hang was measured against', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(20_000);
  });

  it('passes the timeout signal to fetch, and reports the abort it produces', async () => {
    // Proves the composed signal actually reaches fetch rather than being
    // constructed and dropped: the stub rejects with whatever the signal
    // carries, so this message can only appear if the timeout is genuinely
    // on the request. A signalFor that builds the timeout and discards it
    // leaves the stub answering 200 and the drain succeeding.
    //
    // The expected message moved from the fetchJson rename to the
    // translated instanceCannotServe key, because the first request a
    // drain makes is now the tier check and probeRoute turns a timeout
    // there into a Target rather than an exception. Deliberately still an
    // exact message, not a bare .rejects.toThrow(): this file exists
    // because the deadline was once guarded by nothing at all, and
    // "something threw" is satisfied by a caller-supplied signal too. The
    // rename itself stays pinned by tests/cardanoUrlHandling.test.ts's
    // timeout-after-the-tier-check case.
    const controller = new AbortController();
    controller.abort(new DOMException('aborted', 'TimeoutError'));
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          throw init.signal.reason;
        }
        return new Response('[]', { status: 200 });
      }),
    );

    await expect(cardanoYaci.fetchEvents(config, null)).rejects.toThrow(
      CARDANO_MESSAGES.instanceCannotServe,
    );
  });

  it('still honours a caller signal alongside its own deadline', async () => {
    // Both have to apply: the deadline ends a hang, the caller's signal ends
    // a sync the user pressed Stop on.
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const caller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          throw new DOMException('aborted', 'AbortError');
        }
        return new Response('[]', { status: 200 });
      }),
    );
    caller.abort();

    await expect(
      cardanoYaci.fetchEvents(config, null, caller.signal),
    ).rejects.toThrow();
    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
  });

  it('applies its own deadline even when the caller supplied a live signal', async () => {
    // The composed path, which is the one the UI actually uses:
    // MainScreen.handleRefreshOne passes a live AbortController signal
    // through syncSource into fetchEvents. The other tests here either pass
    // no caller signal or pass an already-aborted one, and both of those
    // survive a signalFor that calls AbortSignal.timeout and then discards
    // its result - so without this test the branch that matters in
    // production is the one branch left unguarded.
    const expired = new AbortController();
    expired.abort(new DOMException('deadline', 'TimeoutError'));
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(expired.signal);
    const live = new AbortController(); // deliberately NOT aborted
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          throw init.signal.reason;
        }
        return new Response('[]', { status: 200 });
      }),
    );

    await expect(
      cardanoYaci.fetchEvents(config, null, live.signal),
    ).rejects.toThrow(CARDANO_MESSAGES.instanceCannotServe);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
  });

  it('aborts a request already in flight when the caller stops it', async () => {
    // Every other test here checks the signal's state at the instant fetch is
    // called, so all of them survive a signalFor that picks the caller's
    // signal only when it has ALREADY aborted. That weakening would leave a
    // user's Stop with nothing listening until the 20s deadline - the Stop
    // button doing nothing being the complaint this branch set out to fix.
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
      new AbortController().signal, // a deadline that never fires
    );
    const live = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );

    const pending = cardanoYaci.fetchEvents(config, null, live.signal);
    live.abort(new DOMException('aborted', 'AbortError'));

    // Raced rather than awaited directly so the failure is a clear
    // "never aborted" in milliseconds instead of a suite timeout.
    const outcome = await Promise.race([
      pending.then(
        () => 'resolved',
        (error: unknown) => (error as Error).name,
      ),
      new Promise((resolve) => setTimeout(() => resolve('never aborted'), 50)),
    ]);
    expect(outcome).toBe('AbortError');
  });
});
