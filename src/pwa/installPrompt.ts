import { useSyncExternalStore } from 'react';

/**
 * The PWA install offer.
 *
 * The deployed app has always been installable - Chromium's own check
 * reports no errors and fires `beforeinstallprompt` - but nothing listened
 * for that event, so whether a phone ever offered to install Coineda was
 * left to the browser's own heuristics: Chrome on Android shows its
 * mini-infobar only after enough engagement and sometimes not at all, and
 * Safari on iOS has no prompt of any kind. This module keeps the event so
 * the app can make the offer itself, and recognises iOS, where the only
 * route is Share -> Add to Home Screen and the best the app can do is say so.
 */

/** Chromium's event; not in the DOM lib types. */
export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export const INSTALL_DISMISSED_KEY = 'coineda.installDismissed';

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
let capturing = false;

/**
 * Starts listening. Called once from the entry point, before React mounts:
 * the event can fire as soon as the service worker is active, and one that
 * fires before any component subscribes would otherwise be lost.
 */
export const captureInstallPrompt = (): void => {
  if (capturing) {
    return;
  }
  capturing = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    // Holding the event back is what lets the app's own button show the
    // dialog later; it also stands Chrome's mini-infobar down, so the
    // offer is made once, by the app, rather than twice.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    emit();
  });
};

/** Already running as an installed app (any platform). */
export const isStandalone = (): boolean => {
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) {
      return true;
    }
  } catch {
    // no matchMedia - treat as a browser tab
  }
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
};

/**
 * iPhone or iPad Safari. iPadOS reports itself as a Mac, so a Mac with a
 * touch screen counts too - no real Mac has one.
 */
export const isIos = (): boolean =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export type InstallOffer =
  /** Chromium: the app can show the browser's install dialog. */
  | { kind: 'prompt'; install: () => Promise<void> }
  /** iOS: no dialog exists, only the Share sheet. */
  | { kind: 'ios' }
  | { kind: 'none' };

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const install = async (): Promise<void> => {
  const event = deferred;
  if (!event) {
    return;
  }
  // An event can be prompted only once, whatever the answer.
  deferred = null;
  emit();
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === 'accepted') {
    installed = true;
    emit();
  }
};

const PROMPT: InstallOffer = { kind: 'prompt', install };
const IOS: InstallOffer = { kind: 'ios' };
const NONE: InstallOffer = { kind: 'none' };

const snapshot = (): InstallOffer => {
  // Electron serves the app over coineda://, and an installed copy has
  // nothing left to install.
  if (
    installed ||
    (location.protocol !== 'http:' && location.protocol !== 'https:') ||
    isStandalone()
  ) {
    return NONE;
  }
  if (deferred) {
    return PROMPT;
  }
  return isIos() ? IOS : NONE;
};

export const useInstallOffer = (): InstallOffer =>
  useSyncExternalStore(subscribe, snapshot, () => NONE);

/** Test seam: forget any captured event. */
export const resetInstallPromptForTests = (): void => {
  deferred = null;
  installed = false;
  emit();
};
