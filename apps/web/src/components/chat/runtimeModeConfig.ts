import type { RuntimeMode, ServerProvider } from "@t3tools/contracts";
import { isRuntimeModeSupported } from "@t3tools/shared/runtimeModes";
import {
  type LucideIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  ShieldIcon,
  SparklesIcon,
} from "lucide-react";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
  native: {
    label: "Use harness policy",
    description: "The provider's own permission rules decide; its approvals still apply.",
    icon: ShieldIcon,
  },
};

// The generic defaults list: project settings offer exactly these, and the composer's
// managed rows start from them. Native is never a default; the composer adds it per
// selected provider through resolveComposerRuntimeMode.
export const runtimeModeOptions: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/** One row of the composer's mode picker. A disabled row is a retained selection, not a choice. */
export type ComposerRuntimeModeOption = {
  readonly mode: RuntimeMode;
  readonly disabled: boolean;
} & (typeof runtimeModeConfig)[RuntimeMode];

type ModeProvider = Pick<ServerProvider, "supportedRuntimeModes">;

const nativeBlockReason = (targetCount: number) =>
  targetCount > 1
    ? "Use harness policy is unavailable for one or more selected providers. Choose compatible providers or another permission mode."
    : "Use harness policy is unavailable for the selected provider. Choose a compatible provider or another permission mode.";

/** How a native selection is shown while the selected provider does not advertise it. */
export const unavailableNativeRuntimeModeOption: ComposerRuntimeModeOption = {
  mode: "native",
  ...runtimeModeConfig.native,
  label: "Use harness policy (Unavailable)",
  description: nativeBlockReason(1),
  disabled: true,
};

/**
 * What the composer offers and shows for a thread's runtime mode. Managed rows follow the
 * selected instance's advertised list (an absent or empty list keeps all four, as before,
 * and an unoffered managed mode is still displayed as the first offered managed one). Native
 * needs every dispatch target to advertise it; otherwise a native selection stays selected as a
 * disabled row with the reason sends are refused, and nothing is written in its place.
 */
export function resolveComposerRuntimeMode(input: {
  readonly mode: RuntimeMode;
  readonly provider: ModeProvider | undefined;
  readonly targets?: ReadonlyArray<ModeProvider | undefined>;
}): {
  readonly options: ReadonlyArray<ComposerRuntimeModeOption>;
  readonly selectedMode: RuntimeMode;
  readonly blockReason: string | null;
} {
  const targets = input.targets ?? [input.provider];
  const nativeSupported =
    targets.length > 0 &&
    targets.every(
      (target) =>
        target !== undefined && isRuntimeModeSupported("native", target.supportedRuntimeModes),
    );
  const options: ComposerRuntimeModeOption[] = runtimeModeOptions
    .filter((mode) => isRuntimeModeSupported(mode, input.provider?.supportedRuntimeModes))
    .map((mode) => ({ mode, ...runtimeModeConfig[mode], disabled: false }));
  if (nativeSupported) {
    options.push({ mode: "native", ...runtimeModeConfig.native, disabled: false });
  } else if (input.mode === "native") {
    options.push(
      targets.length > 1
        ? { ...unavailableNativeRuntimeModeOption, description: nativeBlockReason(targets.length) }
        : unavailableNativeRuntimeModeOption,
    );
  }
  const selectedMode =
    input.mode === "native" || options.some((option) => option.mode === input.mode)
      ? input.mode
      : (options.find((option) => option.mode !== "native")?.mode ?? input.mode);
  return {
    options,
    selectedMode,
    blockReason:
      input.mode === "native" && !nativeSupported ? nativeBlockReason(targets.length) : null,
  };
}
