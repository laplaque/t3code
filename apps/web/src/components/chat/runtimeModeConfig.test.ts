import { RuntimeMode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeModeConfig, runtimeModeOptions } from "./runtimeModeConfig";

describe("runtimeModeConfig", () => {
  it("describes every runtime mode the contract knows, including the native policy", () => {
    for (const mode of RuntimeMode.literals) {
      const entry = runtimeModeConfig[mode];
      expect(entry.label, mode).not.toBe("");
      expect(entry.description, mode).not.toBe("");
      expect(entry.icon, mode).toBeDefined();
    }
    expect(runtimeModeConfig.native.label).toBe("Use harness policy");
  });

  it("keeps the selectable options at the four legacy modes, in their existing order", () => {
    expect(runtimeModeOptions).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
  });
});
