import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  type ModelSelection,
  PlanId,
  ProjectId,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInteractionMode,
  ProviderThreadId,
  RunId,
  type RuntimeMode,
  RuntimeRequestId,
  type ServerProvider,
  ThreadId,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { createModelSelection } from "@t3tools/shared/model";
import { USAGE_LIMITS_COMMAND } from "@t3tools/shared/usageLimits";
import { AsyncResult } from "effect/reactivity";
import { type RefObject, useImperativeHandle, useRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// The command boundary is the observable: a refused send or resume must never reach it.
const state = vi.hoisted(() => ({
  commands: [] as Array<{ readonly label: string; readonly value: unknown }>,
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    ...(await importOriginal()),
    useOrchestrationCommand: ((command: { readonly label: string }) => async (value: unknown) => {
      state.commands.push({ label: command.label, value });
      return AsyncResult.success({ sequence: 1, feedbackId: "lab-feedback" });
    }) as never,
  };
});
vi.mock(import("../../hooks/useSettings"), async (importOriginal) => {
  const { DEFAULT_UNIFIED_SETTINGS } = await import("@t3tools/contracts");
  return {
    ...(await importOriginal()),
    useClientSettingsHydrated: () => true,
    useEnvironmentSettings: ((
      _environmentId: unknown,
      selector?: (settings: unknown) => unknown,
    ) => (selector ? selector(DEFAULT_UNIFIED_SETTINGS) : DEFAULT_UNIFIED_SETTINGS)) as never,
  };
});

import "~/index.css";

import { act, render } from "../../../test/render";
import { DraftId, type DraftSessionState, useComposerDraftStore } from "../../composerDraftStore";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import type {
  LatestProposedPlanState,
  PendingApproval,
  PendingUserInput,
} from "../../session-logic";
import type { SessionPhase } from "../../types";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerFooterModeControls } from "./ComposerFooterControls";
import {
  resolveComposerRuntimeMode,
  runtimeModeConfig,
  runtimeModeOptions,
} from "./runtimeModeConfig";
import { useComposerResume } from "./useComposerResume";
import { useComposerSend } from "./useComposerSend";

const START_TURN = "environment-data:commands:thread:start-turn";
const UNAVAILABLE_LABEL = "Use harness policy (Unavailable)";
const SINGLE_BLOCK_REASON =
  "Use harness policy is unavailable for the selected provider. Choose a compatible provider or another permission mode.";
const FANOUT_BLOCK_REASON =
  "Use harness policy is unavailable for one or more selected providers. Choose compatible providers or another permission mode.";

const environmentId = EnvironmentId.make("environment-native-lab");
const projectId = ProjectId.make("project-native-lab");
const LAB_MODEL = "lab-model";
const driver = ProviderDriverKind.make("opencode");
// Synthetic instances: no production driver advertises native in this change.
const OPTED_IN = ProviderInstanceId.make("lab_opted_in");
const MANAGED_ONLY = ProviderInstanceId.make("lab_managed_only");
const ABSENT_LIST = ProviderInstanceId.make("lab_absent_list");
const EMPTY_LIST = ProviderInstanceId.make("lab_empty_list");
const CODEX_MANAGED = ProviderInstanceId.make("lab_codex_managed");
const ALL_MANAGED: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

function provider(
  instanceId: ProviderInstanceId,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
  kind: ProviderDriverKind = driver,
): ServerProvider {
  return {
    instanceId,
    driver: kind,
    displayName: instanceId,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-24T00:00:00.000Z",
    availability: "available",
    models: [
      { slug: LAB_MODEL, name: "Lab model", isCustom: false, isDefault: true, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
    ...(supportedRuntimeModes ? { supportedRuntimeModes } : {}),
  } as ServerProvider;
}

const providersWithOptIn = [
  provider(OPTED_IN, [...ALL_MANAGED, "native"]),
  provider(MANAGED_ONLY, ["approval-required", "full-access"]),
  provider(ABSENT_LIST, undefined),
  provider(EMPTY_LIST, []),
  provider(CODEX_MANAGED, ["approval-required", "full-access"], ProviderDriverKind.make("codex")),
];
// An instance that is not a driver default counts as disabled until settings enable it.
const settings: UnifiedSettings = {
  ...DEFAULT_UNIFIED_SETTINGS,
  providerInstances: Object.fromEntries(
    providersWithOptIn.map((snapshot) => [
      snapshot.instanceId,
      { driver: snapshot.driver, enabled: true },
    ]),
  ),
};
// The same instance after its capability advertisement loses native.
const providersAfterCapabilityLoss = providersWithOptIn.map((snapshot) =>
  snapshot.instanceId === OPTED_IN ? provider(OPTED_IN, ALL_MANAGED) : snapshot,
);
// The same catalog once Limits holds data for the managed-only instance: the server then
// advertises /usage-limits on it, as withUsageLimitsCommands does.
const providersWithUsageLimits = providersWithOptIn.map((snapshot) =>
  snapshot.instanceId === MANAGED_ONLY
    ? { ...snapshot, slashCommands: [USAGE_LIMITS_COMMAND] }
    : snapshot,
);

interface Spies {
  readonly runtimeModeWrites: RuntimeMode[];
  readonly threadErrors: Array<string | null>;
  readonly persisted: unknown[];
  readonly advanced: unknown[];
  readonly approvals: unknown[];
  readonly interrupts: unknown[];
  readonly queuedEdits: unknown[];
  readonly interactionModes: unknown[];
  readonly feedbackSubmissions: unknown[];
  readonly usageLimitsOpened: unknown[];
  readonly usageLimitsAutocomplete: unknown[];
}

interface HarnessHandles {
  readonly composer: RefObject<ChatComposerHandle | null>;
  readonly send: ReturnType<typeof useComposerSend>["onSend"];
  readonly resume: () => Promise<void>;
  readonly runtimeMode: RuntimeMode;
}

interface HarnessProps {
  readonly ids: ReturnType<typeof idsFor>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly routeKind: "server" | "draft";
  readonly initialRuntimeMode: RuntimeMode;
  readonly initialInstanceId: ProviderInstanceId;
  readonly fanout?: ReadonlyArray<ModelSelection> | null;
  readonly phase?: SessionPhase;
  readonly canInterrupt?: boolean;
  readonly resumableRunId?: RunId | null;
  readonly approval?: PendingApproval | null;
  readonly question?: PendingUserInput | null;
  readonly queuedEdit?: boolean;
  readonly planMode?: boolean;
  readonly proposedPlan?: boolean;
  readonly providerThreadStarted?: boolean;
  readonly usageLimits?: boolean;
  readonly mountComposer?: boolean;
  readonly handles: RefObject<HarnessHandles | null>;
  readonly spies: Spies;
}

function idsFor(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const threadId = ThreadId.make(`thread-${slug}`);
  const threadRef = scopeThreadRef(environmentId, threadId);
  return {
    threadId,
    threadRef,
    draftId: DraftId.make(`draft-${slug}`),
    routeThreadKey: scopedThreadKey(threadRef),
  };
}

function threadShell(
  ids: ReturnType<typeof idsFor>,
  instanceId: ProviderInstanceId,
  runtimeMode: RuntimeMode,
  providerThreadStarted: boolean,
): EnvironmentThreadShell {
  const shell: Partial<EnvironmentThreadShell> = {
    environmentId,
    id: ids.threadId,
    projectId,
    title: "Native policy lab",
    providerInstanceId: instanceId,
    modelSelection: createModelSelection(instanceId, LAB_MODEL),
    runtimeMode,
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    activeProviderThreadId: providerThreadStarted
      ? ProviderThreadId.make("lab-provider-thread")
      : null,
    latestRun: null,
    runtime: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    goal: null,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: "2026-10-24T00:00:00.000Z",
    updatedAt: "2026-10-24T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    pullRequests: [],
  };
  return shell as EnvironmentThreadShell;
}

const project = {
  environmentId,
  id: projectId,
  title: "Native policy lab",
  workspaceRoot: "/lab/native-policy",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
} as EnvironmentProject;

const noop = () => {};
const success = async () => AsyncResult.success<void>(undefined);

/**
 * The slice of ChatView that owns the composer: the real ChatComposer and the real send and
 * resume hooks, with the route, store, provider catalog and command boundaries supplied as
 * fixtures. Mode changes and provider switches go through the same store writes ChatView makes.
 */
function Harness(props: HarnessProps) {
  const { ids, spies } = props;
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const promptRef = useRef("");
  const composerImagesRef = useRef<never[]>([]);
  const composerFilesRef = useRef<never[]>([]);
  const composerTerminalContextsRef = useRef<never[]>([]);
  const feedbackUploadsInFlightRef = useRef(new Set<string>());
  const currentRouteThreadKeyRef = useRef<string | null>(ids.routeThreadKey);
  const [runtimeMode, setRuntimeMode] = useState(props.initialRuntimeMode);
  const [fanout, setFanout] = useState<ReadonlyArray<ModelSelection> | null>(props.fanout ?? null);
  const isServerThread = props.routeKind === "server";
  const composerDraftTarget = isServerThread ? ids.threadRef : ids.draftId;
  const activeThread = threadShell(
    ids,
    props.initialInstanceId,
    runtimeMode,
    props.providerThreadStarted === true,
  );
  const activeProposedPlan: LatestProposedPlanState | null = props.proposedPlan
    ? {
        id: PlanId.make("lab-plan"),
        createdAt: "2026-10-24T00:00:00.000Z",
        updatedAt: "2026-10-24T00:00:00.000Z",
        runId: null,
        planMarkdown: "# Plan\n\n1. Keep the policy.",
        status: "active",
      }
    : null;
  const composerSettings: UnifiedSettings = props.planMode
    ? { ...settings, planModeEnabled: true }
    : settings;
  const draftThread: DraftSessionState | null = isServerThread
    ? null
    : {
        threadId: ids.threadId,
        environmentId,
        projectId,
        logicalProjectKey: "native-policy-lab",
        createdAt: "2026-10-24T00:00:00.000Z",
        runtimeMode,
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        envMode: "local",
        startFromOrigin: false,
      };
  const providerInstanceEntries = deriveProviderInstanceEntries(props.providers);
  const resumableRunId = props.resumableRunId ?? null;
  const phase = props.phase ?? "ready";
  const pendingApprovals = props.approval ? [props.approval] : [];
  const pendingUserInputs = props.question ? [props.question] : [];
  const draftAnswers: Record<string, PendingUserInputDraftAnswer> = props.question
    ? { [props.question.questions[0]!.id]: { selectedOptionValues: ["yes"] } }
    : {};
  const activePendingProgress = props.question
    ? derivePendingUserInputProgress(props.question.questions, draftAnswers, 0)
    : null;
  const setThreadError = (_threadId: ThreadId | null, error: string | null) => {
    spies.threadErrors.push(error);
  };
  const persistThreadSettingsForNextTurn = async (input: unknown) => {
    spies.persisted.push(input);
    return success();
  };
  const onAdvanceActivePendingUserInput = () => {
    spies.advanced.push(true);
  };
  const onRespondToApproval = async (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
    feedback?: string,
  ) => {
    spies.approvals.push({ requestId, decision, feedback });
    return AsyncResult.success({ sequence: 1 });
  };
  const handleInteractionModeChange = (mode: ProviderInteractionMode) => {
    spies.interactionModes.push(mode);
  };
  const queuedRunEdit = {
    isEditing: props.queuedEdit === true,
    saveEdit: async (draft: { readonly prompt: string }) => {
      spies.queuedEdits.push(draft.prompt);
    },
  };
  const onInterrupt = () => {
    spies.interrupts.push(true);
  };
  const handleRuntimeModeChange = (mode: RuntimeMode) => {
    spies.runtimeModeWrites.push(mode);
    setRuntimeMode(mode);
  };
  const onProviderModelSelect = (instanceId: ProviderInstanceId, model: string) => {
    useComposerDraftStore
      .getState()
      .setModelSelection(composerDraftTarget, createModelSelection(instanceId, model), {
        explicit: true,
        replaceOptions: true,
      });
  };
  // Local usage data for the selected instance. ChatView derives the composer's command
  // callback and the hook's local inputs from the same facts; the lab adds no attachments or
  // context, so the data alone decides eligibility. The autocomplete callback is spied apart
  // from the panel so a typed submission is known to have gone through the send hook.
  const usageLimitsAvailable = props.usageLimits === true;
  const openUsageLimits = () => {
    spies.usageLimitsOpened.push(true);
    return true;
  };
  const onUsageLimitsCommand = () => {
    spies.usageLimitsAutocomplete.push(true);
    openUsageLimits();
  };

  const { onSend } = useComposerSend({
    environmentId,
    routeThreadKey: ids.routeThreadKey,
    currentRouteThreadKeyRef,
    draftId: isServerThread ? null : ids.draftId,
    draftThread,
    activeThread,
    activeThreadKey: ids.routeThreadKey,
    activeThreadBranch: "main",
    activeProject: project,
    activeProjectDefaultModelSelection: null,
    activeProposedPlan,
    activeMessageCount: 0,
    isServerThread,
    isLocalDraftThread: !isServerThread,
    isGitRepo: true,
    phase,
    runtimeMode,
    sendEnvMode: "local",
    startFromOrigin: false,
    localCheckoutBranchMismatch: null,
    logicalProjectEnvironments: [] as never,
    providerInstanceEntries,
    composerRef,
    composerDraftTarget,
    promptRef,
    composerImagesRef,
    composerFilesRef,
    composerTerminalContextsRef,
    feedbackUploadsInFlightRef,
    queuedRunEdit: queuedRunEdit as never,
    isConnecting: false,
    isRevertingCheckpoint: false,
    threadDetailLoading: false,
    activeEnvironmentUnavailable: false,
    isSendBusy: false,
    sendQueuesBehindSetup: false,
    isDraftHeroState: false,
    panelAnimationsActive: false,
    panelAnimationDurationMs: 0,
    keepFullHistory: false,
    resumeCompactionTokens: null,
    showPlanFollowUpPrompt: props.proposedPlan === true,
    usageLimitsKey: usageLimitsAvailable ? ids.routeThreadKey : null,
    usageLimitsOffered: usageLimitsAvailable,
    openUsageLimits,
    clearUsageLimitsFor: noop,
    needsLoadBalancing: false,
    loadBalancing: { pending: false, environmentId: null } as never,
    readPendingEnvironmentChange: () => null,
    pendingApprovals,
    respondingRequestIds: [],
    activePendingProgress,
    onAdvanceActivePendingUserInput,
    onRespondToApproval,
    beginLocalDispatch: noop,
    resetLocalDispatch: noop,
    beginWorktreeSetup: noop,
    captureDraftHeroComposerRect: noop,
    setDockedDraftHeroThreadKey: noop,
    setSetupQueueSendThreadKey: noop,
    setOptimisticUserMessages: noop,
    setFeedbackSubmissionsByThreadKey: (update) => {
      spies.feedbackSubmissions.push(update);
    },
    setThreadError,
    setKeepFullHistory: noop,
    anchorNewTurn: noop,
    acknowledgeActiveThreadWoke: noop,
    handleInteractionModeChange,
    handleNewThreadInActiveProject: noop,
    persistThreadSettingsForNextTurn,
  });
  const { onResume } = useComposerResume({
    environmentId,
    routeThreadKey: ids.routeThreadKey,
    currentRouteThreadKeyRef,
    activeThread,
    resumableRunId,
    hasHeldQueuedRuns: false,
    isSendBusy: false,
    isConnecting: false,
    isRevertingCheckpoint: false,
    threadDetailLoading: false,
    activeEnvironmentUnavailable: false,
    runtimeMode,
    interactionMode: "default",
    localCheckoutBranchMismatch: null,
    composerRef,
    persistThreadSettingsForNextTurn,
    clearUsageLimitsFor: noop,
    scrollToEnd: noop,
    setThreadError,
  });
  useImperativeHandle(props.handles, () => ({
    composer: composerRef,
    send: onSend,
    resume: onResume,
    runtimeMode,
  }));

  if (props.mountComposer === false) return null;
  return (
    <ChatComposer
      composerDraftTarget={composerDraftTarget}
      environmentId={environmentId}
      canOperateThread
      attachmentUploadsCapabilityKnown
      supportsAttachmentUploads={false}
      supportsQuestionAttachments={false}
      maxFileAttachmentBytes={null}
      routeKind={props.routeKind}
      routeThreadRef={ids.threadRef}
      draftId={isServerThread ? null : ids.draftId}
      multipleModelSelections={fanout}
      supportsMultipleModels={!isServerThread}
      onMultipleModelSelectionsChange={setFanout}
      activeThreadId={ids.threadId}
      activeThreadEnvironmentId={environmentId}
      activeThread={activeThread}
      activeThreadShell={activeThread}
      promptHistoryMessages={[]}
      isServerThread={isServerThread}
      isLocalDraftThread={!isServerThread}
      forceExpandedOnMobile={false}
      projectSelectionRequired={false}
      phase={phase}
      canInterrupt={props.canInterrupt ?? false}
      isConnecting={false}
      isSendBusy={false}
      canResume={resumableRunId !== null}
      sendDisabledReason={null}
      isPreparingWorktree={false}
      isCompacting={false}
      bannerItems={[]}
      resumeCompactionTokens={null}
      keepFullHistory={false}
      onToggleKeepFullHistory={noop}
      onUsageLimitsCommand={usageLimitsAvailable ? onUsageLimitsCommand : undefined}
      activeTaskSteps={null}
      threadSyncPhase={null}
      environmentUnavailable={null}
      activePendingApproval={props.approval ?? null}
      pendingApprovals={pendingApprovals}
      pendingUserInputs={pendingUserInputs}
      activePendingProgress={activePendingProgress}
      activePendingResolvedAnswers={
        props.question ? { [props.question.questions[0]!.id]: "yes" } : null
      }
      activePendingIsResponding={false}
      activePendingDraftAnswers={draftAnswers}
      activePendingQuestionIndex={0}
      respondingRequestIds={[]}
      showPlanFollowUpPrompt={props.proposedPlan === true}
      activeProposedPlan={activeProposedPlan}
      activeTasksProgress={null}
      activeThreadModelSelection={createModelSelection(props.initialInstanceId, LAB_MODEL)}
      reportedModelSelection={null}
      activeProjectId={projectId}
      activeContextWindow={null}
      compactThreadUnavailable
      compactDisabled
      compactDisabledReason={null}
      resolvedTheme="light"
      settings={composerSettings}
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      terminalOpen={false}
      gitCwd={null}
      pullRequestProjectId={null}
      pullRequestRepository={null}
      threadPullRequests={undefined}
      restingControlsHost={null}
      restingControlsHaveLeadingContext={false}
      onRestingControlsVisibilityChange={noop}
      getTimelineScrollableNode={() => null}
      isTimelineAtLogicalEnd={() => true}
      timelineOverflows={false}
      onComposerOverlayHeightChange={noop}
      onRestingChange={noop}
      runtimeMode={runtimeMode}
      interactionMode="default"
      lockedProvider={null}
      providerStatuses={[...props.providers]}
      providerCatalogKnown
      activeProjectDefaultModelSelection={null}
      promptRef={promptRef}
      composerImagesRef={composerImagesRef}
      composerFilesRef={composerFilesRef}
      composerTerminalContextsRef={composerTerminalContextsRef}
      composerRef={composerRef}
      onPageScrollKeyDown={noop}
      onPageScrollKeyUp={noop}
      onPageScrollRelease={noop}
      editingQueuedAttachments={props.queuedEdit ? [] : null}
      onRemoveEditingQueuedAttachment={noop}
      onCompactContext={noop}
      onSend={onSend}
      onResume={onResume}
      onInterrupt={onInterrupt}
      onImplementPlanInNewThread={noop}
      onRespondToApproval={onRespondToApproval}
      onSelectActivePendingUserInputOption={noop}
      onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
      onDismissActivePendingUserInput={noop}
      onPreviousActivePendingUserInputQuestion={noop}
      onChangeActivePendingUserInputCustomAnswer={noop}
      onProviderModelSelect={onProviderModelSelect}
      onOpenProviderSetup={noop}
      getModelDisabledReason={() => null}
      toggleInteractionMode={noop}
      handleRuntimeModeChange={handleRuntimeModeChange}
      handleInteractionModeChange={handleInteractionModeChange}
      focusComposer={noop}
      scheduleComposerFocus={noop}
      setThreadError={setThreadError}
      onExpandImage={noop}
      onFileOpen={noop}
    />
  );
}

function newSpies(): Spies {
  return {
    runtimeModeWrites: [],
    threadErrors: [],
    persisted: [],
    advanced: [],
    approvals: [],
    interrupts: [],
    queuedEdits: [],
    interactionModes: [],
    feedbackSubmissions: [],
    usageLimitsOpened: [],
    usageLimitsAutocomplete: [],
  };
}

type MountOptions = Omit<HarnessProps, "ids" | "handles" | "spies" | "providers"> & {
  readonly providers?: ReadonlyArray<ServerProvider>;
};

async function setup() {
  state.commands.length = 0;
  await page.viewport(1280, 900);
}

async function mount(name: string, options: MountOptions) {
  const ids = idsFor(name);
  const spies = newSpies();
  const handles: RefObject<HarnessHandles | null> = { current: null };
  const { providers = providersWithOptIn, ...harnessOptions } = options;
  const element = (next: Partial<MountOptions> = {}) => (
    <Harness
      ids={ids}
      handles={handles}
      spies={spies}
      {...harnessOptions}
      {...next}
      providers={next.providers ?? providers}
    />
  );
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(element()));
  const target = options.routeKind === "server" ? ids.threadRef : ids.draftId;
  const draftPrompt = () => useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
  const selectInstance = async (instanceId: ProviderInstanceId) => {
    await act(() => {
      useComposerDraftStore
        .getState()
        .setModelSelection(target, createModelSelection(instanceId, LAB_MODEL), {
          explicit: true,
          replaceOptions: true,
        });
    });
  };
  const typePrompt = async (text: string) => {
    await userEvent.click(screen.getByTestId("composer-editor"));
    await userEvent.keyboard(text);
    await expect.poll(draftPrompt).toBe(text);
  };
  const sendContext = () => handles.current!.composer.current!.getSendContext();
  const rerender = (next: Partial<MountOptions>) => screen.rerender(element(next));
  const environment = stack.move();
  return {
    screen,
    ids,
    spies,
    handles,
    draftPrompt,
    selectInstance,
    typePrompt,
    sendContext,
    rerender,
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

const modeTrigger = (screen: Awaited<ReturnType<typeof mount>>["screen"]) =>
  screen.getByRole("combobox", { name: "Runtime mode" });

describe("native policy choice", () => {
  it("offers Use harness policy for an instance that explicitly advertises it and records the choice", async () => {
    await setup();
    await using fixture = await mount("offers native", {
      routeKind: "server",
      initialRuntimeMode: "full-access",
      initialInstanceId: OPTED_IN,
    });
    await userEvent.click(modeTrigger(fixture.screen));
    await userEvent.click(page.getByRole("option", { name: /^Use harness policy/ }));
    expect(fixture.spies.runtimeModeWrites).toEqual(["native"]);
    await expect.element(modeTrigger(fixture.screen)).toHaveTextContent("Use harness policy");
    expect(fixture.sendContext().runtimeModeBlockReason).toBeNull();
  });

  it.each([MANAGED_ONLY, ABSENT_LIST, EMPTY_LIST])(
    "does not offer Use harness policy when the capability list is managed-only, absent or empty (%s)",
    async (instanceId) => {
      await setup();
      await using fixture = await mount(`no native ${instanceId}`, {
        routeKind: "server",
        initialRuntimeMode: "full-access",
        initialInstanceId: instanceId,
      });
      await userEvent.click(modeTrigger(fixture.screen));
      const options = page.getByRole("option");
      await expect.element(options.first()).toBeVisible();
      const labels = (await options.all()).map((option) =>
        option.element().querySelector("span.font-medium")?.textContent?.trim(),
      );
      const expected =
        instanceId === MANAGED_ONLY
          ? ["Supervised", "Full access"]
          : ["Supervised", "Auto-accept edits", "Auto", "Full access"];
      expect(labels).toEqual(expected);
      expect(fixture.spies.runtimeModeWrites).toEqual([]);
    },
  );
});

describe("retained native selection", () => {
  it.each(["server", "draft"] as const)(
    "keeps native selected, shows it as unavailable and refuses sends after switching to an instance without it (%s)",
    async (routeKind) => {
      await setup();
      await using fixture = await mount(`switch away ${routeKind}`, {
        routeKind,
        initialRuntimeMode: "native",
        initialInstanceId: OPTED_IN,
      });
      await fixture.typePrompt("Keep my policy");
      await fixture.selectInstance(MANAGED_ONLY);

      await expect.element(modeTrigger(fixture.screen)).toHaveTextContent(UNAVAILABLE_LABEL);
      const send = fixture.screen.getByRole("button", { name: SINGLE_BLOCK_REASON });
      await expect.element(send).toBeDisabled();
      expect(fixture.handles.current?.runtimeMode).toBe("native");
      expect(fixture.spies.runtimeModeWrites).toEqual([]);
      expect(fixture.sendContext().runtimeModeBlockReason).toBe(SINGLE_BLOCK_REASON);

      await userEvent.click(fixture.screen.getByTestId("composer-editor"));
      await userEvent.keyboard("{Enter}");
      await userEvent.click(send, { force: true });
      expect(state.commands).toEqual([]);
      expect(fixture.spies.persisted).toEqual([]);
      expect(fixture.draftPrompt()).toBe("Keep my policy");
    },
  );

  it("keeps the same refusal when the selected instance loses the capability", async () => {
    await setup();
    await using fixture = await mount("capability loss", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: OPTED_IN,
    });
    await fixture.typePrompt("Still native");
    await fixture.rerender({ providers: providersAfterCapabilityLoss });

    await expect.element(modeTrigger(fixture.screen)).toHaveTextContent(UNAVAILABLE_LABEL);
    await expect
      .element(fixture.screen.getByRole("button", { name: SINGLE_BLOCK_REASON }))
      .toBeDisabled();
    expect(fixture.spies.runtimeModeWrites).toEqual([]);
    expect(fixture.sendContext().runtimeModeBlockReason).toBe(SINGLE_BLOCK_REASON);
    expect(fixture.draftPrompt()).toBe("Still native");
  });

  it("recovers when a compatible instance is chosen again and sends with the retained native policy", async () => {
    await setup();
    await using fixture = await mount("recover instance", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: OPTED_IN,
    });
    await fixture.typePrompt("Back on policy");
    await fixture.selectInstance(MANAGED_ONLY);
    await expect.element(modeTrigger(fixture.screen)).toHaveTextContent(UNAVAILABLE_LABEL);
    await fixture.selectInstance(OPTED_IN);

    await expect.element(modeTrigger(fixture.screen)).toHaveTextContent("Use harness policy");
    expect(fixture.sendContext().runtimeModeBlockReason).toBeNull();
    const send = fixture.screen.getByRole("button", { name: "Submit message" });
    await expect.element(send).toBeEnabled();
    await userEvent.click(send);
    await expect.poll(() => state.commands.map((command) => command.label)).toEqual([START_TURN]);
    expect(state.commands[0]?.value).toMatchObject({ input: { runtimeMode: "native" } });
    expect(fixture.spies.persisted).toHaveLength(1);
    await expect.poll(fixture.draftPrompt).toBe("");
  });

  it("recovers when the user explicitly picks a managed mode, which is then what gets sent", async () => {
    await setup();
    await using fixture = await mount("recover managed", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: MANAGED_ONLY,
    });
    await fixture.typePrompt("Fall back deliberately");
    await expect.element(modeTrigger(fixture.screen)).toHaveTextContent(UNAVAILABLE_LABEL);

    await userEvent.click(modeTrigger(fixture.screen));
    await expect
      .element(page.getByRole("option", { name: /^Use harness policy/ }))
      .toHaveAttribute("aria-disabled", "true");
    await userEvent.click(page.getByRole("option", { name: /^Full access/ }));
    expect(fixture.spies.runtimeModeWrites).toEqual(["full-access"]);
    await expect.element(modeTrigger(fixture.screen)).toHaveTextContent("Full access");
    expect(fixture.sendContext().runtimeModeBlockReason).toBeNull();

    await userEvent.click(fixture.screen.getByRole("button", { name: "Submit message" }));
    await expect.poll(() => state.commands.map((command) => command.label)).toEqual([START_TURN]);
    expect(state.commands[0]?.value).toMatchObject({ input: { runtimeMode: "full-access" } });
  });
});

describe("send and resume refusal", () => {
  it("refuses a direct send-hook call for unsupported native before touching the draft or a command", async () => {
    await setup();
    await using fixture = await mount("direct send", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: MANAGED_ONLY,
    });
    await fixture.typePrompt("Direct call");
    await act(() => fixture.handles.current!.send());

    expect(fixture.spies.threadErrors).toEqual([SINGLE_BLOCK_REASON]);
    expect(state.commands).toEqual([]);
    expect(fixture.spies.persisted).toEqual([]);
    expect(fixture.draftPrompt()).toBe("Direct call");
  });

  it("refuses resume for unsupported native before persisting settings or starting a turn", async () => {
    await setup();
    await using fixture = await mount("refused resume", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: MANAGED_ONLY,
      resumableRunId: RunId.make("run-interrupted"),
    });
    await act(() => fixture.handles.current!.resume());

    expect(fixture.spies.threadErrors).toEqual([SINGLE_BLOCK_REASON]);
    expect(fixture.spies.persisted).toEqual([]);
    expect(state.commands).toEqual([]);
  });

  it("resumes normally when the selected instance supports the retained native policy", async () => {
    await setup();
    await using fixture = await mount("allowed resume", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: OPTED_IN,
      resumableRunId: RunId.make("run-interrupted"),
    });
    await act(() => fixture.handles.current!.resume());

    expect(fixture.spies.threadErrors).toEqual([null]);
    expect(fixture.spies.persisted).toHaveLength(1);
    expect(state.commands.map((command) => command.label)).toEqual([START_TURN]);
    expect(state.commands[0]?.value).toMatchObject({
      input: { runtimeMode: "native", manualContinuationOfRunId: "run-interrupted" },
    });
  });

  it("resumes without a mounted composer as before, since no provider context can refuse", async () => {
    await setup();
    await using fixture = await mount("resume without composer", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: MANAGED_ONLY,
      resumableRunId: RunId.make("run-interrupted"),
      mountComposer: false,
    });
    await act(() => fixture.handles.current!.resume());

    expect(fixture.spies.persisted).toHaveLength(1);
    expect(state.commands.map((command) => command.label)).toEqual([START_TURN]);
  });
});

describe("multiple models", () => {
  it("refuses a mixed fanout for native and preserves every selected model and the draft", async () => {
    await setup();
    const selections = [
      createModelSelection(OPTED_IN, LAB_MODEL),
      createModelSelection(MANAGED_ONLY, LAB_MODEL),
    ];
    await using fixture = await mount("mixed fanout", {
      routeKind: "draft",
      initialRuntimeMode: "native",
      initialInstanceId: OPTED_IN,
      fanout: selections,
    });
    await fixture.typePrompt("Fan out carefully");

    expect(fixture.sendContext().runtimeModeBlockReason).toBe(FANOUT_BLOCK_REASON);
    await expect
      .element(fixture.screen.getByRole("button", { name: FANOUT_BLOCK_REASON }))
      .toBeDisabled();
    await act(() => fixture.handles.current!.send());
    expect(fixture.spies.threadErrors).toEqual([FANOUT_BLOCK_REASON]);
    expect(state.commands).toEqual([]);
    expect(fixture.sendContext().multipleModelSelections).toEqual(selections);
    expect(fixture.draftPrompt()).toBe("Fan out carefully");
  });

  it("keeps native sendable when every fanout target advertises it", async () => {
    await setup();
    await using fixture = await mount("fanout opted in", {
      routeKind: "draft",
      initialRuntimeMode: "native",
      initialInstanceId: OPTED_IN,
      fanout: [
        createModelSelection(OPTED_IN, LAB_MODEL),
        createModelSelection(OPTED_IN, "lab-model-2"),
      ],
      providers: [
        provider(OPTED_IN, [...ALL_MANAGED, "native"]),
        provider(MANAGED_ONLY, ["approval-required", "full-access"]),
      ],
    });
    await fixture.typePrompt("Fan out on policy");

    expect(fixture.sendContext().runtimeModeBlockReason).toBeNull();
    await expect.element(modeTrigger(fixture.screen)).toHaveTextContent("Use harness policy");
    await expect
      .element(fixture.screen.getByRole("button", { name: "Submit message" }))
      .toBeEnabled();
    // The send passes the native check; the test environment then stops it at the existing
    // server capability check, which is not what this scenario is about.
    await act(() => fixture.handles.current!.send());
    expect(fixture.spies.threadErrors).not.toContain(FANOUT_BLOCK_REASON);
    expect(fixture.draftPrompt()).toBe("Fan out on policy");
  });
});

describe("compact controls", () => {
  it("shows the retained unavailable native selection in the overflow menu and lets a managed mode be chosen", async () => {
    await setup();
    const onRuntimeModeChange = vi.fn();
    const { options } = resolveComposerRuntimeMode({
      mode: "native",
      provider: providersWithOptIn.find((snapshot) => snapshot.instanceId === MANAGED_ONLY),
    });
    await using screen = await render(
      <CompactComposerControlsMenu
        interactionMode="default"
        runtimeMode="native"
        runtimeModeOptions={options}
        showInteractionModeToggle={false}
        onToggleInteractionMode={noop}
        onRuntimeModeChange={onRuntimeModeChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "More composer controls" }));
    const unavailable = page.getByRole("menuitemradio", { name: UNAVAILABLE_LABEL });
    await expect.element(unavailable).toHaveAttribute("aria-checked", "true");
    await expect.element(unavailable).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(unavailable, { force: true });
    expect(onRuntimeModeChange).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("menuitemradio", { name: "Full access" }));
    expect(onRuntimeModeChange).toHaveBeenCalledWith("full-access");
  });
});

describe("pending requests and interrupt stay usable", () => {
  it("answers a pending question through the composer while native is unavailable", async () => {
    await setup();
    const question: PendingUserInput = {
      requestId: RuntimeRequestId.make("question-1"),
      createdAt: "2026-10-24T00:00:00.000Z",
      questions: [
        {
          id: "scope",
          header: "Scope",
          question: "Continue with the current scope?",
          options: [
            { label: "Yes", value: "yes" },
            { label: "No", value: "no" },
          ] as never,
          multiSelect: false,
        },
      ],
      responseCapability: "live",
      dismissible: false,
    };
    await using fixture = await mount("pending question", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: MANAGED_ONLY,
      question,
    });
    // The label reads "Submit" or "Submit answer" depending on the footer's width.
    const submit = fixture.screen.getByRole("button", { name: /^Submit( answer)?$/ });
    await expect.element(submit).toBeEnabled();
    await userEvent.click(submit);
    await expect.poll(() => fixture.spies.advanced).toHaveLength(1);
    expect(state.commands).toEqual([]);
  });

  it("keeps approval actions and interrupt available while native is unavailable", async () => {
    await setup();
    const approval: PendingApproval = {
      requestId: RuntimeRequestId.make("approval-1"),
      requestKind: "command",
      createdAt: "2026-10-24T00:00:00.000Z",
      detail: "rm -rf build",
      responseCapability: "live",
    };
    await using fixture = await mount("pending approval", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: MANAGED_ONLY,
      approval,
      phase: "running",
      canInterrupt: true,
    });
    await userEvent.click(fixture.screen.getByRole("button", { name: "Approve" }));
    await expect
      .poll(() => fixture.spies.approvals)
      .toEqual([{ requestId: approval.requestId, decision: "accept" }]);
    await userEvent.click(fixture.screen.getByRole("button", { name: "Stop generation" }));
    expect(fixture.spies.interrupts).toHaveLength(1);
    expect(state.commands).toEqual([]);
  });
});

const UPLOAD_FEEDBACK = "environment-data:commands:thread:upload-feedback";
const sendButton = (screen: Awaited<ReturnType<typeof mount>>["screen"]) =>
  screen.getByRole("button", { name: /^(Submit|Queue|Steer) message$|^Update queued message$/ });

describe("existing non-turn actions stay available while native is unavailable", () => {
  it("sends typed decline feedback for a pending approval that accepts it and starts no turn", async () => {
    await setup();
    const approval: PendingApproval = {
      requestId: RuntimeRequestId.make("approval-feedback"),
      requestKind: "command",
      createdAt: "2026-10-24T00:00:00.000Z",
      detail: "rm -rf build",
      responseCapability: "live",
      supportsFeedback: true,
    };
    await using fixture = await mount("typed approval feedback", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: MANAGED_ONLY,
      approval,
      phase: "running",
    });
    await fixture.typePrompt("Skip the deletion, the build directory is still needed");
    const send = sendButton(fixture.screen);
    await expect.element(send).toBeEnabled();
    await userEvent.click(send);
    await expect
      .poll(() => fixture.spies.approvals)
      .toEqual([
        {
          requestId: approval.requestId,
          decision: "decline",
          feedback: "Skip the deletion, the build directory is still needed",
        },
      ]);
    await expect.poll(fixture.draftPrompt).toBe("");
    expect(state.commands).toEqual([]);
    expect(fixture.spies.threadErrors).not.toContain(SINGLE_BLOCK_REASON);
  });

  it("saves a queued-message edit through the existing edit path and starts no turn", async () => {
    await setup();
    await using fixture = await mount("queued edit", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: MANAGED_ONLY,
      queuedEdit: true,
    });
    await fixture.typePrompt("Updated queued instructions");
    const send = sendButton(fixture.screen);
    await expect.element(send).toBeEnabled();
    await userEvent.click(send);
    await expect.poll(() => fixture.spies.queuedEdits).toEqual(["Updated queued instructions"]);
    expect(state.commands).toEqual([]);
    expect(fixture.spies.persisted).toEqual([]);
  });

  it("keeps standalone /plan and /default as local mode changes", async () => {
    await setup();
    await using fixture = await mount("standalone slash", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: MANAGED_ONLY,
      planMode: true,
    });
    await fixture.typePrompt("/plan");
    await expect.element(sendButton(fixture.screen)).toBeEnabled();
    await act(() => fixture.handles.current!.send());
    await expect.poll(() => fixture.spies.interactionModes).toEqual(["plan"]);
    await expect.poll(fixture.draftPrompt).toBe("");

    await fixture.typePrompt("/default");
    await act(() => fixture.handles.current!.send());
    await expect.poll(() => fixture.spies.interactionModes).toEqual(["plan", "default"]);
    expect(state.commands).toEqual([]);
    expect(fixture.spies.threadErrors).not.toContain(SINGLE_BLOCK_REASON);
  });

  it("uploads Codex feedback through its existing boundary and starts no turn", async () => {
    await setup();
    await using fixture = await mount("codex feedback", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: CODEX_MANAGED,
      providerThreadStarted: true,
    });
    await fixture.typePrompt("/feedback The diff view lost my scroll position");
    await expect.element(sendButton(fixture.screen)).toBeEnabled();
    await act(() => fixture.handles.current!.send());
    await expect
      .poll(() => state.commands.map((command) => command.label))
      .toEqual([UPLOAD_FEEDBACK]);
    expect(state.commands[0]?.value).toMatchObject({
      input: { threadId: fixture.ids.threadId, reason: "The diff view lost my scroll position" },
    });
    expect(fixture.spies.feedbackSubmissions.length).toBeGreaterThanOrEqual(2);
    await expect.poll(fixture.draftPrompt).toBe("");
    expect(fixture.spies.threadErrors).not.toContain(SINGLE_BLOCK_REASON);
  });
});

describe("local /usage-limits", () => {
  const USAGE_LIMITS_HINT = USAGE_LIMITS_COMMAND.description;

  it("answers typed /usage-limits locally through Enter and the button while native is unavailable", async () => {
    await setup();
    await using fixture = await mount("local usage limits", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: MANAGED_ONLY,
      providers: providersWithUsageLimits,
      usageLimits: true,
    });
    // Typing opens the suggestion; Escape dismisses it so Enter submits the typed text
    // rather than picking the suggestion through its own callback.
    await fixture.typePrompt("/usage-limits");
    await expect.element(page.getByText(USAGE_LIMITS_HINT)).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText(USAGE_LIMITS_HINT)).not.toBeInTheDocument();
    expect(fixture.draftPrompt()).toBe("/usage-limits");
    await expect.element(sendButton(fixture.screen)).toBeEnabled();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => fixture.spies.usageLimitsOpened).toHaveLength(1);
    await expect.poll(fixture.draftPrompt).toBe("");

    await fixture.typePrompt("/usage-limits");
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText(USAGE_LIMITS_HINT)).not.toBeInTheDocument();
    await userEvent.click(sendButton(fixture.screen));
    await expect.poll(() => fixture.spies.usageLimitsOpened).toHaveLength(2);
    await expect.poll(fixture.draftPrompt).toBe("");
    expect(fixture.spies.usageLimitsAutocomplete).toEqual([]);
    expect(state.commands).toEqual([]);
    expect(fixture.spies.persisted).toEqual([]);
    expect(fixture.spies.threadErrors).not.toContain(SINGLE_BLOCK_REASON);
  });

  it("keeps refusing typed /usage-limits when no local usage data is offered", async () => {
    await setup();
    await using fixture = await mount("usage limits without data", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: MANAGED_ONLY,
    });
    await fixture.typePrompt("/usage-limits");
    await userEvent.keyboard("{Escape}");
    const send = fixture.screen.getByRole("button", { name: SINGLE_BLOCK_REASON });
    await expect.element(send).toBeDisabled();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(send, { force: true });
    await act(() => fixture.handles.current!.send());
    expect(fixture.spies.threadErrors).toEqual([SINGLE_BLOCK_REASON]);
    expect(fixture.spies.usageLimitsOpened).toEqual([]);
    expect(state.commands).toEqual([]);
    expect(fixture.spies.persisted).toEqual([]);
    expect(fixture.draftPrompt()).toBe("/usage-limits");
  });
});

describe("plan follow-ups", () => {
  it("refuses an unsupported native plan follow-up before the draft is consumed", async () => {
    await setup();
    await using fixture = await mount("refused plan follow-up", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: MANAGED_ONLY,
      planMode: true,
      proposedPlan: true,
    });
    await fixture.typePrompt("Tighten the second step");
    await act(() => fixture.handles.current!.send());
    expect(fixture.spies.threadErrors).toEqual([SINGLE_BLOCK_REASON]);
    expect(state.commands).toEqual([]);
    expect(fixture.spies.persisted).toEqual([]);
    expect(fixture.draftPrompt()).toBe("Tighten the second step");
  });

  it("treats /plan as a plan follow-up first, so it is refused rather than switching modes", async () => {
    await setup();
    await using fixture = await mount("plan follow-up precedence", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: MANAGED_ONLY,
      planMode: true,
      proposedPlan: true,
    });
    await fixture.typePrompt("/plan");
    await act(() => fixture.handles.current!.send());
    expect(fixture.spies.threadErrors).toEqual([SINGLE_BLOCK_REASON]);
    expect(fixture.spies.interactionModes).toEqual([]);
    expect(state.commands).toEqual([]);
    expect(fixture.draftPrompt()).toBe("/plan");
  });

  it("sends a plan follow-up normally when the selected instance supports native", async () => {
    await setup();
    await using fixture = await mount("allowed plan follow-up", {
      routeKind: "server",
      initialRuntimeMode: "native",
      initialInstanceId: OPTED_IN,
      planMode: true,
      proposedPlan: true,
    });
    await fixture.typePrompt("Tighten the second step");
    await act(() => fixture.handles.current!.send());
    await expect.poll(() => state.commands.map((command) => command.label)).toEqual([START_TURN]);
    expect(state.commands[0]?.value).toMatchObject({
      input: { runtimeMode: "native", interactionMode: "plan" },
    });
    expect(fixture.spies.persisted).toHaveLength(1);
    await expect.poll(fixture.draftPrompt).toBe("");
  });
});

describe("footer mode controls", () => {
  it("labels a native selection missing from the offered options as unavailable instead of Supervised", async () => {
    await setup();
    const legacyOptions = runtimeModeOptions.map((mode) => ({ mode, ...runtimeModeConfig[mode] }));
    await using screen = await render(
      <ComposerFooterModeControls
        showInteractionModeToggle={false}
        interactionMode="default"
        runtimeMode="native"
        runtimeModeOptions={legacyOptions}
        onToggleInteractionMode={noop}
        onRuntimeModeChange={noop}
      />,
    );
    await expect
      .element(screen.getByRole("combobox", { name: "Runtime mode" }))
      .toHaveTextContent(UNAVAILABLE_LABEL);
  });

  it("keeps showing Supervised for a managed mode missing from the offered options", async () => {
    await setup();
    const withoutAuto = runtimeModeOptions
      .filter((mode) => mode !== "auto")
      .map((mode) => ({ mode, ...runtimeModeConfig[mode] }));
    await using screen = await render(
      <ComposerFooterModeControls
        showInteractionModeToggle={false}
        interactionMode="default"
        runtimeMode="auto"
        runtimeModeOptions={withoutAuto}
        onToggleInteractionMode={noop}
        onRuntimeModeChange={noop}
      />,
    );
    await expect
      .element(screen.getByRole("combobox", { name: "Runtime mode" }))
      .toHaveTextContent("Supervised");
  });
});
