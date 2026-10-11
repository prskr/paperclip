import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  clients: {} as Record<string, unknown>,
  execInPod: vi.fn(),
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

vi.mock("../../src/pod-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/pod-exec.js")>()),
  execInPod: h.execInPod,
}));

import plugin from "../../src/plugin.js";

const readyCr = {
  metadata: { uid: "uid-1" },
  status: { conditions: [{ type: "Ready", status: "True" }], podName: "pc-abc-pod" },
};

function podWithAgent(agent: Record<string, unknown>) {
  return {
    metadata: { uid: "pod-uid-1" },
    status: { phase: "Running", containerStatuses: [{ name: "agent", ...agent }] },
  };
}

const OOM_RESTARTED = podWithAgent({
  ready: true,
  restartCount: 1,
  state: { running: {} },
  lastState: { terminated: { reason: "OOMKilled", finishedAt: new Date(Date.now() + 60_000).toISOString() } },
});

let leaseSeq = 0;
function run(leaseId: string) {
  return plugin.definition.onEnvironmentExecute!({
    driverKey: "kubernetes",
    companyId: "acme",
    environmentId: "env-1",
    config: { inCluster: true, backend: "sandbox-cr" },
    lease: {
      providerLeaseId: leaseId,
      metadata: {
        namespace: "paperclip-acme",
        backend: "sandbox-cr",
        podName: "pc-abc-pod",
      },
    },
    command: "sh",
    args: ["-c", "echo hi"],
    timeoutMs: 5_000,
  } as never);
}

beforeEach(() => {
  h.execInPod.mockReset();
  leaseSeq += 1;
});

describe("onEnvironmentExecute (sandbox-cr OOM handling)", () => {
  it("reports an OOM-killed exec as not timed out, with a hint and restart metadata", async () => {
    const getCr = vi.fn().mockResolvedValue(readyCr);
    h.clients = {
      custom: { getNamespacedCustomObject: getCr },
      core: { readNamespacedPod: vi.fn().mockResolvedValue(OOM_RESTARTED) },
    };
    h.execInPod.mockRejectedValue(new Error("websocket closed"));
    const leaseId = `pc-oom-throw-${leaseSeq}`;

    const result = await run(leaseId);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(137);
    expect(result.stderr).toContain("agent container was OOMKilled (restartCount=1)");
    expect(result.stderr).toContain("defaultResources.limits.memory");
    expect(result.metadata).toMatchObject({
      containerRestartCount: 1,
      containerLastTerminationReason: "OOMKilled",
    });

    // The ready cache was dropped: the next exec re-runs the readiness wait.
    const crReadsAfterFirst = getCr.mock.calls.length;
    h.execInPod.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    await run(leaseId);
    expect(getCr.mock.calls.length).toBeGreaterThan(crReadsAfterFirst);
  });

  it("keeps timedOut=true for a watchdog timeout when the container did not restart", async () => {
    h.clients = {
      custom: { getNamespacedCustomObject: vi.fn().mockResolvedValue(readyCr) },
      core: {
        readNamespacedPod: vi
          .fn()
          .mockResolvedValue(podWithAgent({ ready: true, restartCount: 0, state: { running: {} } })),
      },
    };
    h.execInPod.mockRejectedValue(new Error("exec timed out after 5000ms"));
    const result = await run(`pc-timeout-${leaseSeq}`);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).not.toContain("OOMKilled");
  });

  it("appends the OOM hint on exit 137 and drops the ready cache", async () => {
    const getCr = vi.fn().mockResolvedValue(readyCr);
    h.clients = {
      custom: { getNamespacedCustomObject: getCr },
      core: { readNamespacedPod: vi.fn().mockResolvedValue(OOM_RESTARTED) },
    };
    h.execInPod.mockResolvedValue({ exitCode: 137, stdout: "", stderr: "Killed" });
    const leaseId = `pc-oom-137-${leaseSeq}`;

    const result = await run(leaseId);
    expect(result.exitCode).toBe(137);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("Killed");
    expect(result.stderr).toContain("OOMKilled (restartCount=1)");

    const reads = getCr.mock.calls.length;
    await run(leaseId);
    expect(getCr.mock.calls.length).toBeGreaterThan(reads);
  });

  it("keeps the ready cache after a successful exec", async () => {
    const getCr = vi.fn().mockResolvedValue(readyCr);
    h.clients = { custom: { getNamespacedCustomObject: getCr }, core: {} };
    h.execInPod.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
    const leaseId = `pc-ok-${leaseSeq}`;
    await run(leaseId);
    const reads = getCr.mock.calls.length;
    await run(leaseId);
    expect(getCr.mock.calls.length).toBe(reads);
  });
  it("keeps the ready cache and skips the pod read on an ordinary command failure", async () => {
    const getCr = vi.fn().mockResolvedValue(readyCr);
    const readPod = vi.fn();
    h.clients = { custom: { getNamespacedCustomObject: getCr }, core: { readNamespacedPod: readPod } };
    h.execInPod.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "no such file" });
    const leaseId = `pc-fail-${leaseSeq}`;
    const result = await run(leaseId);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("no such file");
    const reads = getCr.mock.calls.length;
    await run(leaseId);
    expect(getCr.mock.calls.length).toBe(reads);
    expect(readPod).not.toHaveBeenCalled();
  });
});
