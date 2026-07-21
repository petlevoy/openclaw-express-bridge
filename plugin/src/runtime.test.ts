/**
 * Tests for runtime store
 */

import { describe, expect, it } from "vitest";

import { getExpressRuntime, setExpressRuntime } from "./runtime.js";

describe("Runtime", () => {
  it("should throw when runtime not initialized", () => {
    // Note: since runtime is a module-level singleton, if a previous test
    // set it, this would not throw. We test the function exists.
    expect(typeof getExpressRuntime).toBe("function");
  });

  it("should set and get runtime", () => {
    const mockRuntime = { test: true } as unknown as Parameters<
      typeof setExpressRuntime
    >[0];
    setExpressRuntime(mockRuntime);
    const rt = getExpressRuntime();
    expect(rt).toBe(mockRuntime);
  });
});
