import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// vitest doesn't enable @testing-library auto-cleanup like jest does — wire it explicitly.
afterEach(() => {
  cleanup();
});

// jsdom lacks ResizeObserver/PointerEvent APIs that Radix UI primitives rely on.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  // @ts-expect-error attach stub for tests
  globalThis.ResizeObserver = ResizeObserverStub;
}

// jsdom lacks IntersectionObserver, which Motion's `whileInView` reveals use.
if (typeof globalThis.IntersectionObserver === "undefined") {
  class IntersectionObserverStub {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds: ReadonlyArray<number> = [];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] { return []; }
  }
  // @ts-expect-error attach stub for tests
  globalThis.IntersectionObserver = IntersectionObserverStub;
}

// jsdom lacks matchMedia, which Motion's `useReducedMotion` queries.
if (typeof globalThis.matchMedia === "undefined") {
  // @ts-expect-error attach stub for tests
  globalThis.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    addListener: (): void => {},
    removeListener: (): void => {},
    dispatchEvent: (): boolean => false,
  });
}

if (typeof globalThis.DOMRect === "undefined") {
  // @ts-expect-error attach stub for tests
  globalThis.DOMRect = class {
    x = 0; y = 0; width = 0; height = 0; top = 0; right = 0; bottom = 0; left = 0;
    static fromRect(): unknown { return new (globalThis as { DOMRect: new () => unknown }).DOMRect(); }
    toJSON(): object { return {}; }
  };
}

// Radix Switch (and other primitives) call hasPointerCapture/setPointerCapture/releasePointerCapture
// which jsdom doesn't implement.
if (typeof (globalThis as { Element?: typeof Element }).Element !== "undefined") {
  const proto = (globalThis as { Element: typeof Element }).Element.prototype as unknown as {
    hasPointerCapture?: (id: number) => boolean;
    setPointerCapture?: (id: number) => void;
    releasePointerCapture?: (id: number) => void;
    scrollIntoView?: () => void;
  };
  if (!proto.hasPointerCapture) proto.hasPointerCapture = (): boolean => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = (): void => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = (): void => {};
  if (!proto.scrollIntoView) proto.scrollIntoView = (): void => {};
}
