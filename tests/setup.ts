import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement ResizeObserver, but Radix UI's Popper (used by the
// shadcn Tooltip/DropdownMenu primitives that the sidebar renders) reads
// element size via it on mount, regardless of whether anything is open.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverPolyfill {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver =
    ResizeObserverPolyfill as unknown as typeof ResizeObserver;
}
