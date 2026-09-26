import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  pickSandboxVersion,
  resetSandboxApiVersionCache,
  resolveSandboxApiVersion,
  UnsupportedSandboxApiVersionError,
} from "../../src/sandbox-api-version.js";

function clientsServing(versions: string[] | null, server?: string) {
  const groups = [
    { name: "apps", versions: [{ groupVersion: "apps/v1", version: "v1" }] },
    ...(versions
      ? [
          {
            name: "agents.x-k8s.io",
            versions: versions.map((v) => ({ groupVersion: `agents.x-k8s.io/${v}`, version: v })),
          },
        ]
      : []),
  ];
  return {
    server,
    apis: { getAPIVersions: vi.fn().mockResolvedValue({ groups }) },
  };
}

beforeEach(() => {
  resetSandboxApiVersionCache();
});

describe("pickSandboxVersion", () => {
  it("prefers v1beta1 over v1alpha1 regardless of order", () => {
    expect(pickSandboxVersion(["v1alpha1", "v1beta1"])).toBe("v1beta1");
    expect(pickSandboxVersion(["v1beta1"])).toBe("v1beta1");
  });

  it("falls back to v1alpha1", () => {
    expect(pickSandboxVersion(["v1alpha1"])).toBe("v1alpha1");
  });

  it("returns null when no supported version is served", () => {
    expect(pickSandboxVersion(["v1"])).toBeNull();
    expect(pickSandboxVersion([])).toBeNull();
  });
});

describe("resolveSandboxApiVersion", () => {
  it("picks v1beta1 when the cluster serves both versions", async () => {
    const clients = clientsServing(["v1beta1", "v1alpha1"]);
    await expect(resolveSandboxApiVersion(clients as never)).resolves.toBe("v1beta1");
  });

  it("falls back to v1alpha1 on agent-sandbox v0.4.x clusters", async () => {
    const clients = clientsServing(["v1alpha1"]);
    await expect(resolveSandboxApiVersion(clients as never)).resolves.toBe("v1alpha1");
  });

  it("throws when the group serves only unsupported versions", async () => {
    const clients = clientsServing(["v2"]);
    await expect(resolveSandboxApiVersion(clients as never)).rejects.toBeInstanceOf(
      UnsupportedSandboxApiVersionError,
    );
  });

  it("defaults to v1beta1 when the group is not installed", async () => {
    const clients = clientsServing(null);
    await expect(resolveSandboxApiVersion(clients as never)).resolves.toBe("v1beta1");
  });

  it("defaults to v1beta1 without caching when discovery fails", async () => {
    const getAPIVersions = vi
      .fn()
      .mockRejectedValueOnce(new Error("forbidden"))
      .mockResolvedValueOnce({
        groups: [{ name: "agents.x-k8s.io", versions: [{ version: "v1alpha1" }] }],
      });
    const clients = { apis: { getAPIVersions } };
    await expect(resolveSandboxApiVersion(clients as never)).resolves.toBe("v1beta1");
    await expect(resolveSandboxApiVersion(clients as never)).resolves.toBe("v1alpha1");
    expect(getAPIVersions).toHaveBeenCalledTimes(2);
  });

  it("defaults to v1beta1 when no discovery client is available", async () => {
    await expect(resolveSandboxApiVersion({} as never)).resolves.toBe("v1beta1");
  });

  it("caches the discovered version per API server across client instances", async () => {
    const first = clientsServing(["v1alpha1"], "https://cluster-a:6443");
    const second = clientsServing(["v1beta1"], "https://cluster-a:6443");
    const other = clientsServing(["v1beta1"], "https://cluster-b:6443");
    await expect(resolveSandboxApiVersion(first as never)).resolves.toBe("v1alpha1");
    await expect(resolveSandboxApiVersion(second as never)).resolves.toBe("v1alpha1");
    await expect(resolveSandboxApiVersion(other as never)).resolves.toBe("v1beta1");
    expect(second.apis.getAPIVersions).not.toHaveBeenCalled();
  });

  it("re-discovers after the cache TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const clients = clientsServing(["v1alpha1"], "https://cluster-c:6443");
      await resolveSandboxApiVersion(clients as never);
      vi.advanceTimersByTime(5 * 60_000 + 1);
      await resolveSandboxApiVersion(clients as never);
      expect(clients.apis.getAPIVersions).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
