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

// jsdom doesn't implement the Pointer Events capture methods or
// scrollIntoView. Radix UI's Select calls hasPointerCapture/
// setPointerCapture/releasePointerCapture from its pointer handlers
// unconditionally (not feature-detected), so a click on a SelectItem
// throws instead of selecting it unless these exist.
if (typeof window.HTMLElement.prototype.hasPointerCapture === 'undefined') {
  window.HTMLElement.prototype.hasPointerCapture = () => false;
}
if (typeof window.HTMLElement.prototype.setPointerCapture === 'undefined') {
  window.HTMLElement.prototype.setPointerCapture = () => {};
}
if (typeof window.HTMLElement.prototype.releasePointerCapture === 'undefined') {
  window.HTMLElement.prototype.releasePointerCapture = () => {};
}
if (typeof window.HTMLElement.prototype.scrollIntoView === 'undefined') {
  window.HTMLElement.prototype.scrollIntoView = () => {};
}
