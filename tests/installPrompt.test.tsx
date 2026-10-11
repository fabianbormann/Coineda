import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InstallAppCard } from '@/pwa/InstallAppCard';
import {
  captureInstallPrompt,
  INSTALL_DISMISSED_KEY,
  resetInstallPromptForTests,
} from '@/pwa/installPrompt';

/** Chromium's event, with the two members the app uses. */
const fireInstallPrompt = (outcome: 'accepted' | 'dismissed' = 'accepted') => {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  const prompt = vi.fn().mockResolvedValue(undefined);
  Object.assign(event, {
    prompt,
    userChoice: Promise.resolve({ outcome }),
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return { event, prompt };
};

const setUserAgent = (ua: string) =>
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);

const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

beforeEach(() => {
  localStorage.clear();
  resetInstallPromptForTests();
  captureInstallPrompt();
  setUserAgent(ANDROID);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the install offer', () => {
  it('stays out of the way until the browser says the app can be installed', () => {
    render(<InstallAppCard />);
    expect(screen.queryByTestId('install-app')).toBeNull();
  });

  it('offers the browser’s install dialog once it is available, and holds back Chrome’s own banner', async () => {
    render(<InstallAppCard />);
    const { event, prompt } = fireInstallPrompt();
    expect(event.defaultPrevented).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(prompt).toHaveBeenCalledOnce();
    // Accepted: nothing left to offer.
    expect(screen.queryByTestId('install-app')).toBeNull();
  });

  it('remembers "Not now" on this device', async () => {
    const { unmount } = render(<InstallAppCard />);
    fireInstallPrompt();
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByTestId('install-app')).toBeNull();
    expect(localStorage.getItem(INSTALL_DISMISSED_KEY)).toBe('1');

    unmount();
    render(<InstallAppCard />);
    expect(screen.queryByTestId('install-app')).toBeNull();
  });

  it('explains the Share-sheet route on iOS, which has no install dialog', () => {
    setUserAgent(IPHONE);
    render(<InstallAppCard />);
    expect(screen.getByTestId('install-app')).toHaveTextContent(
      /tap Share in Safari, then “Add to Home Screen”/,
    );
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });

  it('is not offered inside the installed app', () => {
    setUserAgent(IPHONE);
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: query === '(display-mode: standalone)',
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    render(<InstallAppCard />);
    expect(screen.queryByTestId('install-app')).toBeNull();
  });
});
