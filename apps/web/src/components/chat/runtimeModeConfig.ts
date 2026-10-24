import type { RuntimeMode } from "@t3tools/contracts";
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

// Native stays out of every picker until a provider advertises it and the
// composer can hold an unsupported selection without silently replacing it.
export const runtimeModeOptions: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];
