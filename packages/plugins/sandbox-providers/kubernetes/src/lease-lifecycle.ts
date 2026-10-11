/**
 * Resume + destroy lifecycle helpers for Kubernetes sandbox leases.
 *
 * Resume semantics: a lease is resumable only while its workload resource
 * (Sandbox CR or Job) still exists and its pod is Running/Ready (or becomes
 * Ready within a short bounded wait). A sandbox-cr pod whose "agent" container
 * is restarting in place (e.g. after an OOM kill) is waited on for a longer
 * grace period, but a pod replaced by the controller (new UID) is not.
 * Unlike Daytona — where a stopped sandbox can be started again by ID —
 * Kubernetes pods are NOT restartable: once the
 * pod backing a lease is gone or terminally failed, the lease can never be
 * revived in place. That asymmetry is intentional; the plugin reports the
 * lease as expired and the server falls back to a fresh acquireLease, which
 * provisions a new pod.
 *
 * Destroy semantics: the forced cleanup path. Deletes every resource
 * acquireLease created (Sandbox CR / Job, its pod, the per-run Secret),
 * treating 404s as success so it is idempotent and safe to call against
 * half-deleted leases.
 */

import type { KubeClients } from "./kube-client.js";
import { deleteJob, findPodForJob, getJobStatus } from "./job-orchestrator.js";
import { deleteSandboxCr, findPodForSandbox } from "./sandbox-cr-orchestrator.js";
import {
  AGENT_CONTAINER_NAME,
  UNRECOVERABLE_WAITING_REASONS,
  agentTerminationReason,
  extractAgentContainerStatus,
} from "./container-status.js";

/** True when a Kubernetes API error means "resource not found" (HTTP 404). */
export function isKubeNotFoundError(err: unknown): boolean {
  const code = (err as { code?: number; statusCode?: number }).code
    ?? (err as { code?: number; statusCode?: number }).statusCode;
  return code === 404;
}

async function ignoreNotFound(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (err) {
    if (!isKubeNotFoundError(err)) throw err;
  }
}

export type ResumeCheckResult =
  | {
      resumable: true;
      podName: string | null;
      phase: "Pending" | "Running";
      /** Live pod UID (sandbox-cr only); lets the caller record/backfill pod identity. */
      podUid?: string;
      /** "agent" container restarts observed on the (same) pod; sandbox-cr only. */
      restartCount?: number;
      /** Why the previous container incarnation died, e.g. "OOMKilled". */
      lastTerminationReason?: string;
    }
  | { resumable: false; reason: string };

export interface ResumeCheckInput {
  namespace: string;
  /** Workload resource name (Sandbox CR name or Job name) == providerLeaseId. */
  name: string;
  backend: "sandbox-cr" | "job";
  /** Bounded wait for an existing Sandbox pod to report Ready. */
  readyTimeoutMs?: number;
  /**
   * Longer budget used once the "agent" container is observed restarting
   * (terminated / waiting with a recoverable reason). Should cover the kubelet
   * restart back-off cap (300s). Default 5 minutes.
   */
  restartGraceMs?: number;
  pollMs?: number;
  /**
   * Pod UID recorded in the lease metadata. When present and different from
   * the live pod's UID the pod was replaced and its emptyDir workspace is
   * lost. Absent/null = unknown (pod did not exist at acquire time): identity
   * is then not verified and only the liveness checks apply.
   */
  expectedPodUid?: string | null;
}

const DEFAULT_RESTART_GRACE_MS = 300_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CrStatus = {
  phase?: string;
  podName?: string;
  conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
};

/**
 * Check a sandbox-cr lease. The pod uses restartPolicy Always, so an adapter
 * OOM usually restarts the "agent" container inside the SAME pod while the
 * emptyDir volumes survive — that lease is resumable once the container is
 * Ready again, so a restarting container is waited on (up to restartGraceMs)
 * instead of being reported dead. A pod that was deleted and recreated by the
 * controller (UID changed) has fresh, empty emptyDirs and is NOT resumable.
 * Only an explicit Failed state, phase Failed/Succeeded, or Terminating is
 * terminal; Sandbox Ready=False alone is not (it flips during container
 * restarts).
 */
async function checkSandboxCrResumable(
  clients: KubeClients,
  input: ResumeCheckInput,
): Promise<ResumeCheckResult> {
  const readyTimeoutMs = input.readyTimeoutMs ?? 30_000;
  const restartGraceMs = input.restartGraceMs ?? DEFAULT_RESTART_GRACE_MS;
  const pollMs = input.pollMs ?? 1_000;
  const startedAt = Date.now();
  let budgetMs = readyTimeoutMs;
  let lastWaitingOn = "the Sandbox to become Ready";

  for (;;) {
    let cr: { status?: CrStatus };
    try {
      cr = (await clients.custom.getNamespacedCustomObject({
        group: "agents.x-k8s.io",
        version: "v1alpha1",
        namespace: input.namespace,
        plural: "sandboxes",
        name: input.name,
      })) as typeof cr;
    } catch (err) {
      if (isKubeNotFoundError(err)) {
        return { resumable: false, reason: "Sandbox CR no longer exists" };
      }
      return {
        resumable: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    const status = cr.status ?? {};
    const conditions = Array.isArray(status.conditions) ? status.conditions : [];
    const crReady =
      conditions.some((c) => c.type === "Ready" && c.status === "True") ||
      status.phase === "Ready";
    const failedCond = conditions.find((c) => c.type === "Failed" && c.status === "True");
    if (failedCond || status.phase === "Failed") {
      return {
        resumable: false,
        reason: `Sandbox ${input.namespace}/${input.name} failed: ${failedCond?.reason ?? "unknown reason"} — ${failedCond?.message ?? ""}`,
      };
    }
    if (status.phase === "Terminating") {
      return {
        resumable: false,
        reason: `Sandbox ${input.namespace}/${input.name} is Terminating`,
      };
    }

    let podName: string | null;
    try {
      podName = await findPodForSandbox(clients, input.namespace, input.name);
    } catch (err) {
      // CR deleted between the status read and the pod lookup.
      if (isKubeNotFoundError(err)) {
        return { resumable: false, reason: "Sandbox CR no longer exists" };
      }
      // While the Sandbox is not Ready the pod may simply not exist yet; a
      // lookup error then just means "keep waiting".
      if (crReady) throw err;
      podName = null;
    }

    if (!podName) {
      if (crReady) {
        return {
          resumable: false,
          reason: "Sandbox is Ready but no backing pod was found",
        };
      }
      lastWaitingOn = "the Sandbox pod to be created";
    } else {
      let pod: {
        metadata?: { uid?: string; deletionTimestamp?: unknown };
        status?: { phase?: string };
      };
      try {
        pod = (await clients.core.readNamespacedPod({
          namespace: input.namespace,
          name: podName,
        })) as typeof pod;
      } catch (err) {
        if (isKubeNotFoundError(err)) {
          return { resumable: false, reason: `Pod ${podName} no longer exists` };
        }
        throw err;
      }
      const podPhase = pod.status?.phase;
      const terminating = Boolean(pod.metadata?.deletionTimestamp);
      if (terminating || podPhase === "Failed" || podPhase === "Succeeded") {
        return {
          resumable: false,
          reason: `Pod ${podName} is ${terminating ? "terminating" : podPhase}`,
        };
      }
      const livePodUid = pod.metadata?.uid;
      if (input.expectedPodUid && livePodUid && input.expectedPodUid !== livePodUid) {
        return {
          resumable: false,
          reason: `Pod ${podName} was replaced (uid changed); emptyDir workspace lost`,
        };
      }

      const container = extractAgentContainerStatus(pod);
      const containerReady = container ? container.ready : null;
      // With container info, trust it (the Sandbox Ready condition can lag or
      // flap across a restart); without it fall back to the Sandbox condition.
      const ready =
        podPhase === "Running" && (containerReady === null ? crReady : containerReady);
      if (ready) {
        return {
          resumable: true,
          podName,
          phase: "Running",
          ...(livePodUid ? { podUid: livePodUid } : {}),
          ...(container ? { restartCount: container.restartCount } : {}),
          ...(container && agentTerminationReason(container)
            ? { lastTerminationReason: agentTerminationReason(container) }
            : {}),
        };
      }

      if (container) {
        if (
          container.state === "waiting" &&
          container.waitingReason &&
          UNRECOVERABLE_WAITING_REASONS.has(container.waitingReason)
        ) {
          return {
            resumable: false,
            reason: `Pod ${podName} container "${AGENT_CONTAINER_NAME}" cannot start: ${container.waitingReason}`,
          };
        }
        if (container.state === "waiting" || container.state === "terminated") {
          // Recoverable restart (CrashLoopBackOff, ContainerCreating, just
          // OOMKilled, ...): allow the longer restart budget.
          budgetMs = Math.max(budgetMs, restartGraceMs);
          lastWaitingOn = `container "${AGENT_CONTAINER_NAME}" to restart (${
            container.waitingReason ?? container.terminatedReason ?? container.state
          }, restartCount=${container.restartCount})`;
        } else {
          lastWaitingOn = `container "${AGENT_CONTAINER_NAME}" to become Ready`;
        }
      }
    }

    if (Date.now() - startedAt >= budgetMs) {
      return {
        resumable: false,
        reason: `Sandbox ${input.namespace}/${input.name} did not reach Ready within ${budgetMs}ms (waiting for ${lastWaitingOn})`,
      };
    }
    await sleep(pollMs);
  }
}

/**
 * Check whether the workload behind a lease is still alive and exec-able.
 * Returns `resumable: false` (never throws "expected" states) when the
 * resource is gone (404), terminally failed, terminating, or doesn't become
 * Ready within the bounded wait — all of which mean the caller should fall
 * back to a fresh acquireLease.
 */
export async function checkLeaseResumable(
  clients: KubeClients,
  input: ResumeCheckInput,
): Promise<ResumeCheckResult> {
  if (input.backend === "sandbox-cr") {
    return checkSandboxCrResumable(clients, input);
  }

  // ── Job backend ───────────────────────────────────────────────────────────
  let status;
  try {
    status = await getJobStatus(clients, input.namespace, input.name);
  } catch (err) {
    if (isKubeNotFoundError(err)) {
      return { resumable: false, reason: "Job no longer exists" };
    }
    throw err;
  }
  if (status.phase === "Succeeded" || status.phase === "Failed") {
    // Terminal Jobs cannot be re-run in place.
    return { resumable: false, reason: `Job is ${status.phase}` };
  }
  // Pending/Running Jobs are resumable: execute() waits for completion
  // itself, so a not-yet-scheduled pod (podName null) is fine here.
  const podName = await findPodForJob(clients, input.namespace, input.name);
  return {
    resumable: true,
    podName,
    phase: status.phase === "Running" ? "Running" : "Pending",
  };
}

export interface DestroyLeaseInput {
  namespace: string;
  /** Workload resource name (Sandbox CR name or Job name) == providerLeaseId. */
  name: string;
  backend: "sandbox-cr" | "job";
  podName: string | null;
  secretName: string | null;
}

/**
 * Forcibly delete every resource acquireLease created for this lease.
 * Workload first (its deletion cascades to the pod and, via ownerReferences,
 * the per-run Secret in the normal case); then the pod and Secret explicitly
 * so a wedged controller or broken ownerRef cannot strand them. Every delete
 * treats 404 as success — destroy is idempotent.
 */
export async function destroyLeaseResources(
  clients: KubeClients,
  input: DestroyLeaseInput,
): Promise<void> {
  if (input.backend === "sandbox-cr") {
    await ignoreNotFound(deleteSandboxCr(clients, input.namespace, input.name));
  } else {
    await ignoreNotFound(deleteJob(clients, input.namespace, input.name));
  }
  if (input.podName) {
    await ignoreNotFound(
      clients.core.deleteNamespacedPod({
        namespace: input.namespace,
        name: input.podName,
      }),
    );
  }
  if (input.secretName) {
    await ignoreNotFound(
      clients.core.deleteNamespacedSecret({
        namespace: input.namespace,
        name: input.secretName,
      }),
    );
  }
}
