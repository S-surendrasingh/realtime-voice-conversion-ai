import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// `globals: false` in vitest.config.mts means Testing Library's own
// auto-cleanup (which looks for a global `afterEach`) never registers —
// do it explicitly instead, or DOM from one test leaks into the next.
afterEach(() => {
  cleanup();
});
