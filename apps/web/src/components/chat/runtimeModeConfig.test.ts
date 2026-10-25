import { RuntimeMode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveComposerRuntimeMode,
  runtimeModeConfig,
  runtimeModeOptions,
  unavailableNativeRuntimeModeOption,
} from "./runtimeModeConfig";

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

const optedIn = {
  supportedRuntimeModes: [
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
    "native",
  ] as const,
};
const managedOnly = { supportedRuntimeModes: ["approval-required", "full-access"] as const };
const absent = { supportedRuntimeModes: undefined };
const empty = { supportedRuntimeModes: [] as const };
const legacyModes = ["approval-required", "auto-accept-edits", "auto", "full-access"];
const modesOf = (state: ReturnType<typeof resolveComposerRuntimeMode>) =>
  state.options.map((option) => option.mode);
const nativeRow = (state: ReturnType<typeof resolveComposerRuntimeMode>) =>
  state.options.find((option) => option.mode === "native");

describe("resolveComposerRuntimeMode", () => {
  it("offers only the four legacy modes when the instance sends no list or an empty one", () => {
    for (const provider of [absent, empty, undefined]) {
      const state = resolveComposerRuntimeMode({ mode: "auto", provider });
      expect(modesOf(state), JSON.stringify(provider)).toEqual(legacyModes);
      expect(state.selectedMode).toBe("auto");
      expect(state.blockReason).toBeNull();
      expect(state.options.every((option) => option.disabled === false)).toBe(true);
    }
  });

  it("filters the legacy modes to the instance's managed list and never adds native to it", () => {
    const state = resolveComposerRuntimeMode({ mode: "full-access", provider: managedOnly });
    expect(modesOf(state)).toEqual(["approval-required", "full-access"]);
    expect(state.selectedMode).toBe("full-access");
    expect(state.blockReason).toBeNull();
  });

  it("keeps the legacy display substitution for an unoffered managed mode", () => {
    const state = resolveComposerRuntimeMode({ mode: "auto", provider: managedOnly });
    expect(state.selectedMode).toBe("approval-required");
    expect(nativeRow(state)).toBeUndefined();
    expect(state.blockReason).toBeNull();
  });

  it("offers an enabled native choice only when the instance explicitly advertises it", () => {
    const state = resolveComposerRuntimeMode({ mode: "full-access", provider: optedIn });
    expect(modesOf(state)).toEqual([...legacyModes, "native"]);
    expect(nativeRow(state)).toMatchObject({ label: "Use harness policy", disabled: false });
    const selected = resolveComposerRuntimeMode({ mode: "native", provider: optedIn });
    expect(selected.selectedMode).toBe("native");
    expect(selected.blockReason).toBeNull();
  });

  it("retains an unsupported native selection as a disabled unavailable row with a block reason", () => {
    for (const provider of [managedOnly, absent, empty, undefined]) {
      const state = resolveComposerRuntimeMode({ mode: "native", provider });
      expect(state.selectedMode, JSON.stringify(provider)).toBe("native");
      expect(nativeRow(state)).toEqual(unavailableNativeRuntimeModeOption);
      expect(nativeRow(state)?.label).toBe("Use harness policy (Unavailable)");
      expect(state.blockReason).toBe(
        "Use harness policy is unavailable for the selected provider. Choose a compatible provider or another permission mode.",
      );
    }
    const legacyRows = resolveComposerRuntimeMode({ mode: "native", provider: managedOnly });
    expect(modesOf(legacyRows)).toEqual(["approval-required", "full-access", "native"]);
  });

  it("recovers as soon as the selection points at a compatible instance again", () => {
    const lost = resolveComposerRuntimeMode({ mode: "native", provider: managedOnly });
    const recovered = resolveComposerRuntimeMode({ mode: "native", provider: optedIn });
    expect(lost.blockReason).not.toBeNull();
    expect(recovered.blockReason).toBeNull();
    expect(recovered.selectedMode).toBe("native");
    expect(nativeRow(recovered)?.disabled).toBe(false);
  });

  it("requires every fanout target to advertise native", () => {
    const mixed = resolveComposerRuntimeMode({
      mode: "native",
      provider: managedOnly,
      targets: [optedIn, managedOnly],
    });
    expect(mixed.selectedMode).toBe("native");
    expect(nativeRow(mixed)?.disabled).toBe(true);
    expect(mixed.blockReason).toBe(
      "Use harness policy is unavailable for one or more selected providers. Choose compatible providers or another permission mode.",
    );
    expect(nativeRow(mixed)?.description).toBe(mixed.blockReason);

    const unknownInstance = resolveComposerRuntimeMode({
      mode: "native",
      provider: optedIn,
      targets: [optedIn, undefined],
    });
    expect(unknownInstance.blockReason).not.toBeNull();

    const all = resolveComposerRuntimeMode({
      mode: "native",
      provider: optedIn,
      targets: [optedIn, optedIn],
    });
    expect(all.blockReason).toBeNull();
    expect(nativeRow(all)?.disabled).toBe(false);
  });

  it("treats an empty target list as unsupported for native and as neutral for managed modes", () => {
    const native = resolveComposerRuntimeMode({ mode: "native", provider: optedIn, targets: [] });
    expect(native.blockReason).not.toBeNull();
    expect(native.selectedMode).toBe("native");
    const managed = resolveComposerRuntimeMode({
      mode: "full-access",
      provider: optedIn,
      targets: [],
    });
    expect(managed.blockReason).toBeNull();
    expect(modesOf(managed)).toEqual(legacyModes);
  });

  it("never substitutes native for an unoffered managed mode, even when native is all that is offered", () => {
    const nativeOnly = { supportedRuntimeModes: ["native"] as const };
    const state = resolveComposerRuntimeMode({ mode: "auto", provider: nativeOnly });
    expect(modesOf(state)).toEqual(["native"]);
    expect(state.selectedMode).toBe("auto");
    expect(state.blockReason).toBeNull();
  });

  it("filters the managed rows by the selected instance, not by the fanout targets", () => {
    const state = resolveComposerRuntimeMode({
      mode: "full-access",
      provider: managedOnly,
      targets: [optedIn, optedIn],
    });
    expect(modesOf(state)).toEqual(["approval-required", "full-access", "native"]);
    expect(nativeRow(state)?.disabled).toBe(false);
  });
});
