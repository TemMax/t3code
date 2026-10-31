import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { useEnvironments } from "~/state/environments";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentThreadShells } from "~/state/threads";
import { isHostedByThisApp } from "../sidebar/useUpdateEverything";

const HEARTBEAT_MS = 60_000;
const TURN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const holdsTurn = (thread: Pick<OrchestrationV2ThreadShell, "status" | "pendingRuntimeRequest">) =>
  TURN_STATUSES.has(thread.status) || thread.pendingRuntimeRequest !== null;

const hostedAgentsBusyAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) =>
    environmentIds
      .split("\n")
      .filter((id) => id !== "")
      .some((id) =>
        get(environmentThreadShells.environmentThreadsAtom(EnvironmentId.make(id))).some(holdsTurn),
      ),
  ).pipe(Atom.withLabel(`desktop-hosted-agents-busy:${environmentIds}`)),
);

/** Tells the desktop app whether agents on machines it would restart are mid-turn. */
export function AgentActivityReporter() {
  const { environments } = useEnvironments();
  const hosted = environments.filter(
    (environment) => isHostedByThisApp(environment) && environment.connection.phase === "connected",
  );
  const environmentIds = environmentIdsKey(hosted.map(({ environmentId }) => environmentId));
  const busy = useAtomValue(hostedAgentsBusyAtom(environmentIds));
  const known = hosted.length > 0;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports to the desktop main process, which expires windows that stop reporting
  useEffect(() => {
    const report = window.desktopBridge?.reportAgentActivity;
    if (!known || report === undefined) return;
    const send = () => void report(busy).catch(() => undefined);
    send();
    const interval = window.setInterval(send, HEARTBEAT_MS);
    return () => window.clearInterval(interval);
  }, [busy, known]);

  return null;
}
