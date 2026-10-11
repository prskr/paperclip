/**
 * Helpers for reading the state of the sandbox pod's "agent" container.
 *
 * Shared by the resume check (lease-lifecycle.ts) and the execute failure path
 * (plugin.ts). The sandbox pod uses restartPolicy Always, so when the adapter
 * process OOMs, cgroup v2 typically kills the whole container and kubelet
 * restarts it in the SAME pod: emptyDir volumes survive, but the container
 * passes through terminated/waiting (CrashLoopBackOff) states on the way.
 */

import type { KubeClients } from "./kube-client.js";

export const AGENT_CONTAINER_NAME = "agent";

/**
 * Waiting reasons that will never recover on their own (bad image, bad
 * container config). Waiting out a restart grace period for these is pointless.
 */
export const UNRECOVERABLE_WAITING_REASONS: ReadonlySet<string> = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "CreateContainerConfigError",
]);

export interface AgentContainerStatus {
  ready: boolean;
  restartCount: number;
  state: "running" | "waiting" | "terminated" | "unknown";
  /** state.waiting.reason, e.g. CrashLoopBackOff / ContainerCreating. */
  waitingReason?: string;
  /** state.terminated.reason, e.g. OOMKilled / Error. */
  terminatedReason?: string;
  /** lastState.terminated.reason: why the previous incarnation died. */
  lastTerminationReason?: string;
  /** lastState.terminated.finishedAt as epoch ms, when reported. */
  lastTerminatedAtMs?: number;
}

interface RawContainerState {
  waiting?: { reason?: string };
  running?: unknown;
  terminated?: { reason?: string; finishedAt?: string | Date };
}

interface RawContainerStatus {
  name?: string;
  ready?: boolean;
  restartCount?: number;
  state?: RawContainerState;
  lastState?: RawContainerState;
}

/** Extract the "agent" container status from a pod object; null when absent. */
export function extractAgentContainerStatus(pod: unknown): AgentContainerStatus | null {
  const statuses = (pod as { status?: { containerStatuses?: RawContainerStatus[] } })
    ?.status?.containerStatuses;
  const cs = Array.isArray(statuses)
    ? statuses.find((s) => s?.name === AGENT_CONTAINER_NAME)
    : undefined;
  if (!cs) return null;

  const state: AgentContainerStatus["state"] = cs.state?.running
    ? "running"
    : cs.state?.waiting
      ? "waiting"
      : cs.state?.terminated
        ? "terminated"
        : "unknown";
  const finishedAt = cs.lastState?.terminated?.finishedAt;
  const finishedAtMs = finishedAt ? new Date(finishedAt).getTime() : NaN;
  return {
    ready: cs.ready === true,
    restartCount: typeof cs.restartCount === "number" ? cs.restartCount : 0,
    state,
    waitingReason: cs.state?.waiting?.reason,
    terminatedReason: cs.state?.terminated?.reason,
    lastTerminationReason: cs.lastState?.terminated?.reason,
    lastTerminatedAtMs: Number.isFinite(finishedAtMs) ? finishedAtMs : undefined,
  };
}

/**
 * The reason the container most recently died: the current terminated state if
 * it is terminated right now, else the previous incarnation's reason.
 */
export function agentTerminationReason(s: AgentContainerStatus): string | undefined {
  return s.terminatedReason ?? s.lastTerminationReason;
}

/**
 * Whether the container died or restarted at/after `sinceMs`. Used to tell a
 * failure caused by a container restart apart from an unrelated command
 * failure. A previous termination with no finishedAt is treated as recent
 * only while the container is not currently running (conservative).
 */
export function agentRestartedSince(s: AgentContainerStatus, sinceMs: number): boolean {
  if (s.state === "terminated" || s.state === "waiting") return true;
  if (s.lastTerminationReason === undefined) return false;
  if (s.lastTerminatedAtMs === undefined) return !s.ready;
  return s.lastTerminatedAtMs >= sinceMs;
}

/** Best-effort pod read; returns null on any error (callers are on failure paths). */
export async function readAgentContainerStatus(
  clients: KubeClients,
  namespace: string,
  podName: string,
): Promise<AgentContainerStatus | null> {
  try {
    const pod = await clients.core.readNamespacedPod({ namespace, name: podName });
    return extractAgentContainerStatus(pod);
  } catch {
    return null;
  }
}

/** Best-effort pod UID lookup; null when the pod is missing or unreadable. */
export async function readPodUid(
  clients: KubeClients,
  namespace: string,
  podName: string,
): Promise<string | null> {
  try {
    const pod = (await clients.core.readNamespacedPod({ namespace, name: podName })) as {
      metadata?: { uid?: string };
    };
    return pod?.metadata?.uid ?? null;
  } catch {
    return null;
  }
}

export interface AgentFailureInspection {
  restartCount: number;
  lastTerminationReason: string | null;
  /** The container died/restarted during (or after the start of) the failed exec. */
  restarted: boolean;
  oomKilled: boolean;
}

/** Inspect the agent container after a failed exec. Null when status is unreadable. */
export async function inspectAgentContainerAfterFailure(
  clients: KubeClients,
  namespace: string,
  podName: string,
  sinceMs: number,
): Promise<AgentFailureInspection | null> {
  const status = await readAgentContainerStatus(clients, namespace, podName);
  if (!status) return null;
  const restarted = agentRestartedSince(status, sinceMs);
  const reason = agentTerminationReason(status) ?? null;
  return {
    restartCount: status.restartCount,
    lastTerminationReason: reason,
    restarted,
    oomKilled: restarted && reason === "OOMKilled",
  };
}

export function oomKilledHint(restartCount: number): string {
  return `[kubernetes] agent container was OOMKilled (restartCount=${restartCount}); consider raising the memory limit (defaultResources.limits.memory)`;
}
