import type { RuntimeMode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isManagedRuntimeMode,
  isRuntimeModeSupported,
  isRuntimeModeWithinLimit,
  type ManagedRuntimeMode,
  managedRuntimeModeRank,
  resolveProviderRuntimeMode,
} from "./runtimeModes.ts";

const legacyModes = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const satisfies ReadonlyArray<ManagedRuntimeMode>;
const modes = [...legacyModes, "native"] as const satisfies ReadonlyArray<RuntimeMode>;

describe("native support", () => {
  it.each([
    undefined,
    [],
    ["approval-required"],
    ["approval-required", "auto", "full-access"],
    // An instance that offers every managed mode still has not offered native;
    // another instance's explicit advertisement does not carry over.
    ["approval-required", "auto-accept-edits", "auto", "full-access"],
  ] satisfies ReadonlyArray<ReadonlyArray<RuntimeMode> | undefined>)(
    "requires an explicit native advertisement: %j",
    (supported) => {
      expect(isRuntimeModeSupported("native", supported)).toBe(false);
      expect(resolveProviderRuntimeMode("native", supported)).toEqual({
        type: "unsupported",
        runtimeMode: "native",
      });
    },
  );

  it("accepts explicit native support without rewriting it", () => {
    expect(isRuntimeModeSupported("native", ["native"])).toBe(true);
    expect(resolveProviderRuntimeMode("native", ["native"])).toEqual({
      type: "resolved",
      runtimeMode: "native",
    });
    expect(resolveProviderRuntimeMode("native", ["approval-required", "native"])).toEqual({
      type: "resolved",
      runtimeMode: "native",
    });
  });

  it("preserves the existing unsupported legacy fallback", () => {
    expect(resolveProviderRuntimeMode("auto", ["approval-required"])).toEqual({
      type: "resolved",
      runtimeMode: "approval-required",
    });
  });

  it("does not let a native-only advertisement widen legacy support", () => {
    expect(isRuntimeModeSupported("full-access", ["native"])).toBe(false);
    expect(resolveProviderRuntimeMode("full-access", ["native"])).toEqual({
      type: "resolved",
      runtimeMode: "approval-required",
    });
  });
});

describe("legacy compatibility", () => {
  it.each(legacyModes)("keeps %s supported under absent and empty lists", (mode) => {
    for (const supported of [undefined, []]) {
      expect(isRuntimeModeSupported(mode, supported)).toBe(true);
      expect(resolveProviderRuntimeMode(mode, supported)).toEqual({
        type: "resolved",
        runtimeMode: mode,
      });
    }
  });

  it.each(legacyModes)("keeps %s supported when it is advertised", (mode) => {
    expect(isRuntimeModeSupported(mode, [mode])).toBe(true);
    expect(resolveProviderRuntimeMode(mode, [mode, "native"])).toEqual({
      type: "resolved",
      runtimeMode: mode,
    });
  });

  it("classifies exactly the four legacy modes as managed", () => {
    expect(modes.filter(isManagedRuntimeMode)).toEqual([...legacyModes]);
    expect(isManagedRuntimeMode("native")).toBe(false);
  });

  it("ranks the managed modes from Supervised up to Full access", () => {
    const ranks = legacyModes.map(managedRuntimeModeRank);
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    expect(new Set(ranks).size).toBe(legacyModes.length);
  });

  it("keeps the pairwise legacy ceiling matrix", () => {
    const withinLimit: Record<ManagedRuntimeMode, ReadonlyArray<ManagedRuntimeMode>> = {
      "approval-required": ["approval-required"],
      "auto-accept-edits": ["approval-required", "auto-accept-edits"],
      auto: ["approval-required", "auto-accept-edits", "auto"],
      "full-access": ["approval-required", "auto-accept-edits", "auto", "full-access"],
    };
    for (const limit of legacyModes) {
      for (const target of legacyModes) {
        expect(isRuntimeModeWithinLimit(limit, target), `${target} within ${limit}`).toBe(
          withinLimit[limit].includes(target),
        );
      }
    }
  });
});

describe("native comparison", () => {
  it.each(modes)("cannot prove native is within %s, or %s within native", (mode) => {
    expect(isRuntimeModeWithinLimit(mode, "native")).toBe(false);
    expect(isRuntimeModeWithinLimit("native", mode)).toBe(false);
  });
});
