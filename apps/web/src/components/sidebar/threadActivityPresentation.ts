import type { OrchestrationV2ThreadActivityPhase } from "@t3tools/contracts";
import {
  BugIcon,
  CodeIcon,
  EyeIcon,
  FlaskConicalIcon,
  ListChecksIcon,
  SearchIcon,
} from "lucide-react";

export const THREAD_ACTIVITY_PRESENTATION = {
  researching: { Icon: SearchIcon, className: "text-violet-600 dark:text-violet-300" },
  planning: { Icon: ListChecksIcon, className: "text-indigo-600 dark:text-indigo-300" },
  implementing: { Icon: CodeIcon, className: "text-info-foreground" },
  testing: { Icon: FlaskConicalIcon, className: "text-emerald-600 dark:text-emerald-300" },
  debugging: { Icon: BugIcon, className: "text-rose-600 dark:text-rose-300" },
  reviewing: { Icon: EyeIcon, className: "text-fuchsia-600 dark:text-fuchsia-300" },
} satisfies Record<
  OrchestrationV2ThreadActivityPhase,
  { Icon: typeof SearchIcon; className: string }
>;
