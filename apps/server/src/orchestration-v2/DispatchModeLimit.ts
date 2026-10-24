import type { ProviderInteractionMode, RuntimeMode, ThreadId } from "@t3tools/contracts";
import { isRuntimeModeWithinLimit } from "@t3tools/shared/runtimeModes";
import * as Context from "effect/Context";
import type * as Ref from "effect/Ref";

export interface DispatchModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface DispatchModeRefusal extends DispatchModes {
  readonly threadId: ThreadId;
  readonly mode: "runtime" | "interaction";
}

/**
 * A caller checks its target's modes before dispatching, but the target's user can raise them
 * meanwhile; the orchestrator re-checks this limit inside the thread's command lock, where nothing
 * else can change them.
 */
export interface DispatchModeLimitValue extends DispatchModes {
  readonly refused?: Ref.Ref<DispatchModeRefusal | undefined>;
}

export const DispatchModeLimit = Context.Reference<DispatchModeLimitValue | undefined>(
  "t3/orchestration-v2/DispatchModeLimit",
  { defaultValue: () => undefined },
);

const interactionModeRank: Record<ProviderInteractionMode, number> = { plan: 0, default: 1 };

/** A native policy has no place in the managed order, so it exceeds the limit on either side. */
export const exceededDispatchModeLimit = (
  limit: DispatchModes,
  modes: DispatchModes,
): "runtime" | "interaction" | undefined =>
  !isRuntimeModeWithinLimit(limit.runtimeMode, modes.runtimeMode)
    ? "runtime"
    : interactionModeRank[modes.interactionMode] > interactionModeRank[limit.interactionMode]
      ? "interaction"
      : undefined;
