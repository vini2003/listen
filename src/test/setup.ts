import "@testing-library/jest-dom/vitest";
import { afterAll } from "vitest";
import type {} from "vitest/jsdom";

if (typeof jsdom !== "undefined") {
  // Node 26 defines localStorage even without a backing file. Vitest 3 then
  // keeps Node's global, so browser tests must bind storage to their own DOM.
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: jsdom.window.localStorage,
  });
  afterAll(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
}
