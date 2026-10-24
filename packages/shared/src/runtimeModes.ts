import type { RuntimeMode } from "@t3tools/contracts";

/**
 * The four modes T3 enforces itself. `native` leaves policy to the provider's own
 * configuration, so it has no place in the managed ranking below.
 */
export type ManagedRuntimeMode = Exclude<RuntimeMode, "native">;

export type RuntimeModeResolution =
  | { readonly type: "resolved"; readonly runtimeMode: RuntimeMode }
  | { readonly type: "unsupported"; readonly runtimeMode: "native" };

const managedRuntimeModeRanks: Record<ManagedRuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

export function isManagedRuntimeMode(mode: RuntimeMode): mode is ManagedRuntimeMode {
  return mode !== "native";
}

/**
 * Providers that predate the advertisement send no list, or an empty one; the
 * legacy modes stay available there. Native is only ever an explicit entry.
 */
export function isRuntimeModeSupported(
  mode: RuntimeMode,
  supported: ReadonlyArray<RuntimeMode> | undefined,
): boolean {
  if (mode === "native") return supported?.includes(mode) === true;
  return supported === undefined || supported.length === 0 || supported.includes(mode);
}

/**
 * An unoffered legacy mode keeps running as Supervised; an unoffered native
 * policy gets no replacement, because no managed mode stands in for the
 * provider's own rules.
 */
export function resolveProviderRuntimeMode(
  mode: RuntimeMode,
  supported: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeModeResolution {
  if (isRuntimeModeSupported(mode, supported)) return { type: "resolved", runtimeMode: mode };
  if (mode === "native") return { type: "unsupported", runtimeMode: mode };
  return { type: "resolved", runtimeMode: "approval-required" };
}

export function managedRuntimeModeRank(mode: ManagedRuntimeMode): number {
  return managedRuntimeModeRanks[mode];
}

/**
 * T3 cannot order a provider's native policy against its managed modes, nor
 * one native policy against another, so a bounded check never passes with
 * native on either side.
 */
export function isRuntimeModeWithinLimit(limit: RuntimeMode, target: RuntimeMode): boolean {
  return (
    isManagedRuntimeMode(limit) &&
    isManagedRuntimeMode(target) &&
    managedRuntimeModeRank(target) <= managedRuntimeModeRank(limit)
  );
}
