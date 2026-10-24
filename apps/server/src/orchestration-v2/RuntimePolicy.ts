import {
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { resolveProviderRuntimeMode } from "@t3tools/shared/runtimeModes";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectStore from "./ProjectStore.ts";

export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

export class RuntimePolicyNativeUnsupportedError extends Schema.TaggedError<RuntimePolicyNativeUnsupportedError>()(
  "RuntimePolicyNativeUnsupportedError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `Provider instance ${this.providerInstanceId} does not advertise the native runtime policy, so the thread cannot run with it.`;
  }
}

export class RuntimePolicyNativeOverrideConflictError extends Schema.TaggedError<RuntimePolicyNativeOverrideConflictError>()(
  "RuntimePolicyNativeOverrideConflictError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    overrides: Schema.Array(Schema.Literals(["approvalPolicy", "sandboxPolicy"])),
  },
) {
  override get message(): string {
    return `Explicit ${this.overrides.join(" and ")} overrides cannot be combined with the native runtime policy for provider instance ${this.providerInstanceId}.`;
  }
}

export const RuntimePolicyV2Error = Schema.Union([
  RuntimePolicyResolveError,
  RuntimePolicyNativeUnsupportedError,
  RuntimePolicyNativeOverrideConflictError,
]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

// Without a capability snapshot nothing can vouch for native support, so this
// layer refuses it like an instance that does not advertise it.
export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: (input) => {
    const resolution = resolveProviderRuntimeMode(input.thread.runtimeMode, undefined);
    return resolution.type === "unsupported"
      ? Effect.fail(
          new RuntimePolicyNativeUnsupportedError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
          }),
        )
      : Effect.succeed({
          runtimeMode: resolution.runtimeMode,
          interactionMode: input.thread.interactionMode,
          cwd: input.thread.worktreePath,
        });
  },
});

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  ProjectStore.ProjectStoreV2 | ProviderInstanceRegistry.ProviderInstanceRegistry
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        const supportedRuntimeModes =
          instance === undefined
            ? undefined
            : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
        const resolution = resolveProviderRuntimeMode(
          input.thread.runtimeMode,
          supportedRuntimeModes,
        );
        if (resolution.type === "unsupported") {
          return yield* new RuntimePolicyNativeUnsupportedError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
          });
        }
        const cwd =
          input.thread.worktreePath ??
          (yield* projects.get(input.thread.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause: "Project not found.",
                    }),
                  ),
                onSome: (project) => Effect.succeed(project.workspaceRoot),
              }),
            ),
          ));
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: resolution.runtimeMode,
          interactionMode: input.thread.interactionMode,
          cwd,
        });
      }),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.flatMap((policy) => {
              // A native policy belongs to the provider; an explicit T3 sandbox or
              // approval override would silently contradict it, so refuse rather
              // than drop the override.
              const conflicting = (["approvalPolicy", "sandboxPolicy"] as const).filter(
                (key) => override[key] !== undefined,
              );
              if (policy.runtimeMode === "native" && conflicting.length > 0) {
                return Effect.fail(
                  new RuntimePolicyNativeOverrideConflictError({
                    projectId: input.thread.projectId,
                    providerInstanceId: input.modelSelection.instanceId,
                    overrides: conflicting,
                  }),
                );
              }
              return Effect.succeed(
                ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                  ...policy,
                  ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                  ...(override.approvalPolicy === undefined
                    ? {}
                    : { approvalPolicy: override.approvalPolicy }),
                  ...(override.sandboxPolicy === undefined
                    ? {}
                    : { sandboxPolicy: override.sandboxPolicy }),
                  ...(override.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: override.reasoningEffort }),
                }),
              );
            }),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}
