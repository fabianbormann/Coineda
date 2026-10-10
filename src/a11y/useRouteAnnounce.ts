import { useEffect, useRef } from 'react';

/**
 * Names the page and moves focus to its heading when a route mounts.
 *
 * A single-page app swaps content without a page load, so a screen reader
 * hears nothing on navigation. Setting the document title and focusing the
 * page's h1 (which must carry tabIndex={-1}) is what announces the new page.
 * Attach the returned ref to that h1.
 */
// The first announce is the page load, where focus belongs on the document
// so the skip link stays the first Tab stop. Only later navigations move it.
let firstAnnounce = true;

/** Test helper: treat the next announce as the page load again. */
export const resetRouteAnnounce = () => {
  firstAnnounce = true;
};

export const useRouteAnnounce = (title: string) => {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `Coineda – ${title}`;
  }, [title]);
  useEffect(() => {
    if (firstAnnounce) {
      firstAnnounce = false;
      return;
    }
    heading.current?.focus();
  }, []);
  return heading;
};
