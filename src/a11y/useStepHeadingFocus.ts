import { useEffect, useRef } from 'react';

/**
 * Moves focus to the page's h1 when an in-page step changes.
 *
 * A multi-step flow swaps one card for the next, which unmounts the button
 * that was just pressed; focus then falls to <body> and the next Tab starts
 * from the top of the document. Each step renders its own h1 with
 * tabIndex={-1} inside `<main id="main">`, and this lands focus on it. The
 * first render is left alone (that is the page load, or a route change that
 * useRouteAnnounce already handles).
 */
export const useStepHeadingFocus = (step: unknown) => {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    document
      .getElementById('main')
      ?.querySelector<HTMLHeadingElement>('h1')
      ?.focus();
  }, [step]);
};
