import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const grokInstanceId = ProviderInstanceId.make("grok");
const nativeInstanceId = ProviderInstanceId.make("native-capable");
const emptyListInstanceId = ProviderInstanceId.make("empty-list");
const missingInstanceId = ProviderInstanceId.make("missing");
const supportedRuntimeModesByInstance = new Map<
  ProviderInstanceId,
  ReadonlyArray<RuntimeMode> | undefined
>([
  [providerInstanceId, undefined],
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
  [nativeInstanceId, ["approval-required", "native"]],
  [emptyListInstanceId, []],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId): ProviderInstance | undefined =>
  supportedRuntimeModesByInstance.has(instanceId)
    ? ({
        snapshot: {
          getSnapshot: Effect.succeed({
            supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
          } as ServerProvider),
        },
      } as ProviderInstance)
    : undefined;

const layerTest = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Project",
            workspaceRoot: "/project-root",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
  ),
);

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );
});

it.layer(layerTest)("RuntimePolicyV2 native policy", (it) => {
  const resolveNative = (
    instanceId: ProviderInstanceId,
    input: { readonly worktreePath?: string | null; readonly runtimeMode?: RuntimeMode } = {},
  ) =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      return yield* policy.resolve({
        thread: makeThread({
          now,
          worktreePath: input.worktreePath === undefined ? "/worktree" : input.worktreePath,
          runtimeMode: input.runtimeMode ?? "native",
        }),
        modelSelection: { instanceId, model: "test-model" },
      });
    });

  it.effect("refuses native unless the selected instance advertises it explicitly", () =>
    Effect.gen(function* () {
      for (const instanceId of [
        missingInstanceId,
        providerInstanceId,
        emptyListInstanceId,
        grokInstanceId,
      ]) {
        const error = yield* resolveNative(instanceId).pipe(Effect.flip);
        assert.equal(error._tag, "RuntimePolicyNativeUnsupportedError", instanceId);
        assert.equal(error.providerInstanceId, instanceId);
        assert.equal(error.projectId, projectId);
        assert.include(error.message, `${instanceId} does not advertise the native runtime policy`);
      }
    }),
  );

  it.effect("passes an advertised native policy through without T3 overrides", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* resolveNative(nativeInstanceId), {
        runtimeMode: "native",
        interactionMode: "default",
        cwd: "/worktree",
      });
      assert.deepEqual(yield* resolveNative(nativeInstanceId, { worktreePath: null }), {
        runtimeMode: "native",
        interactionMode: "default",
        cwd: "/project-root",
      });
    }),
  );

  it.effect("keeps legacy modes on a native-capable instance unchanged", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveNative(nativeInstanceId, { runtimeMode: "auto" });
      assert.equal(resolved.runtimeMode, "approval-required");
      assert.equal(
        (yield* resolveNative(nativeInstanceId, { runtimeMode: "approval-required" })).runtimeMode,
        "approval-required",
      );
    }),
  );

  const withOverride = <A, E, R>(
    override: RuntimePolicy.RuntimePolicyV2Override,
    effect: Effect.Effect<A, E, R>,
  ) => effect.pipe(Effect.provide(RuntimePolicy.layerWithOverride(override)));

  it.effect("refuses explicit approval or sandbox overrides on a native policy", () =>
    Effect.gen(function* () {
      const overrides: ReadonlyArray<RuntimePolicy.RuntimePolicyV2Override> = [
        { approvalPolicy: "never" },
        { sandboxPolicy: { type: "dangerFullAccess" } },
        { approvalPolicy: null },
        { sandboxPolicy: null },
        { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" }, cwd: "/else" },
      ];
      for (const override of overrides) {
        const error = yield* withOverride(override, resolveNative(nativeInstanceId)).pipe(
          Effect.flip,
        );
        assert.equal(
          error._tag,
          "RuntimePolicyNativeOverrideConflictError",
          JSON.stringify(override),
        );
        assert.equal(error.providerInstanceId, nativeInstanceId);
        assert.equal(error.projectId, projectId);
        if (error._tag === "RuntimePolicyNativeOverrideConflictError") {
          assert.deepEqual(
            error.overrides,
            (["approvalPolicy", "sandboxPolicy"] as const).filter(
              (key) => override[key] !== undefined,
            ),
          );
          assert.include(
            error.message,
            `cannot be combined with the native runtime policy for provider instance ${nativeInstanceId}`,
          );
        }
      }
    }),
  );

  it.effect("allows cwd and reasoning overrides on an advertised native policy", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* withOverride(
          { cwd: "/override", reasoningEffort: "high" },
          resolveNative(nativeInstanceId),
        ),
        {
          runtimeMode: "native",
          interactionMode: "default",
          cwd: "/override",
          reasoningEffort: "high",
        },
      );
    }),
  );

  it.effect("does not let an override turn an unadvertised native policy into a run", () =>
    Effect.gen(function* () {
      const error = yield* withOverride({ cwd: "/override" }, resolveNative(grokInstanceId)).pipe(
        Effect.flip,
      );
      assert.equal(error._tag, "RuntimePolicyNativeUnsupportedError");
    }),
  );

  it.effect("still applies explicit overrides to legacy policies", () =>
    Effect.gen(function* () {
      const resolved = yield* withOverride(
        { approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } },
        resolveNative(providerInstanceId, { runtimeMode: "full-access" }),
      );
      assert.equal(resolved.runtimeMode, "full-access");
      assert.equal(resolved.approvalPolicy, "never");
      assert.deepEqual(resolved.sandboxPolicy, { type: "readOnly" });
    }),
  );
});

it.layer(RuntimePolicy.layer)("RuntimePolicyV2 capability-free layer", (it) => {
  it.effect("refuses native because it cannot know any instance supports it", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const error = yield* policy
        .resolve({
          thread: makeThread({ now, worktreePath: "/worktree", runtimeMode: "native" }),
          modelSelection,
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "RuntimePolicyNativeUnsupportedError");
      assert.equal(error.providerInstanceId, providerInstanceId);
      assert.equal(error.projectId, projectId);
    }),
  );

  it.effect("passes legacy modes through unchanged", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      assert.deepEqual(
        yield* policy.resolve({
          thread: makeThread({ now, worktreePath: "/worktree", runtimeMode: "auto" }),
          modelSelection,
        }),
        { runtimeMode: "auto", interactionMode: "default", cwd: "/worktree" },
      );
    }),
  );
});
