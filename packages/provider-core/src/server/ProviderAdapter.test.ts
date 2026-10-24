import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProviderAdapter from "./ProviderAdapter.ts";

const drivers = ["codex", "claudeAgent", "antigravity", "acpRegistry"].map((kind) =>
  ProviderDriverKind.make(kind),
);
const legacyModes = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
const nativeShortcuts = [
  {},
  { interactionMode: "plan" },
  { approvalPolicy: "never" },
  { sandboxPolicy: { type: "dangerFullAccess" } },
  { approvalPolicy: null },
  { interactionMode: "plan", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
] as const;

describe("ProviderAdapter managed runtime policy", () => {
  it.effect("hands every legacy policy back unchanged, overrides included", () =>
    Effect.gen(function* () {
      for (const runtimeMode of legacyModes) {
        const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode,
          interactionMode: "plan",
          cwd: "/work",
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
          reasoningEffort: "high",
        });
        assert.isTrue(ProviderAdapter.isProviderAdapterV2ManagedRuntimePolicy(policy));
        const managed = yield* ProviderAdapter.requireManagedRuntimePolicy(drivers[0]!, policy);
        assert.strictEqual(managed, policy);
        assert.equal(managed.runtimeMode, runtimeMode);
      }
    }),
  );

  it.effect("fails a native policy with a typed protocol error before any shortcut applies", () =>
    Effect.gen(function* () {
      for (const driver of drivers) {
        for (const shortcut of nativeShortcuts) {
          const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "native",
            interactionMode: "default",
            cwd: null,
            ...shortcut,
          });
          assert.isFalse(ProviderAdapter.isProviderAdapterV2ManagedRuntimePolicy(policy));
          const error = yield* ProviderAdapter.requireManagedRuntimePolicy(driver, policy).pipe(
            Effect.flip,
          );
          assert.equal(error._tag, "ProviderAdapterProtocolError");
          assert.equal(error.driver, driver);
          assert.include(error.message, "native");
        }
      }
    }),
  );
});
