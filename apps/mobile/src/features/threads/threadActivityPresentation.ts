import type { OrchestrationV2ThreadActivityPhase } from "@t3tools/contracts";

import type { AppSymbolName } from "../../components/ui/AppSymbol";

export const THREAD_ACTIVITY_PRESENTATION: Record<
  OrchestrationV2ThreadActivityPhase,
  {
    readonly icon: AppSymbolName;
    readonly textClassName: string;
    readonly iconTintClassName: string;
  }
> = {
  researching: {
    icon: "magnifyingglass",
    textClassName: "text-adaptive-violet-600-400",
    iconTintClassName: "accent-adaptive-violet-600-400",
  },
  planning: {
    icon: "list.number",
    textClassName: "text-adaptive-indigo-600-300",
    iconTintClassName: "accent-adaptive-indigo-600-300",
  },
  implementing: {
    icon: "chevron.left.forwardslash.chevron.right",
    textClassName: "text-adaptive-sky-600-400",
    iconTintClassName: "accent-adaptive-sky-600-400",
  },
  testing: {
    icon: "testtube.2",
    textClassName: "text-adaptive-emerald-700-300",
    iconTintClassName: "accent-adaptive-emerald-700-300",
  },
  debugging: {
    icon: "ladybug",
    textClassName: "text-adaptive-rose-600-400",
    iconTintClassName: "accent-adaptive-rose-600-400",
  },
  reviewing: {
    icon: "eye",
    textClassName: "text-adaptive-fuchsia-600-300",
    iconTintClassName: "accent-adaptive-fuchsia-600-300",
  },
};
