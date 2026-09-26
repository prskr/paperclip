import { describe, it, expect } from "vitest";
import { kubernetesProviderConfigSchema, parseKubernetesProviderConfig } from "../../src/types.js";

describe("kubernetesProviderConfigSchema", () => {
  it("accepts inCluster=true with no kubeconfig", () => {
    const parsed = parseKubernetesProviderConfig({ inCluster: true });
    expect(parsed.inCluster).toBe(true);
    expect(parsed.namespacePrefix).toBe("paperclip-");
    expect(parsed.imageAllowList).toEqual([]);
    expect(parsed.egressMode).toBe("standard");
    expect(parsed.jobTtlSecondsAfterFinished).toBe(900);
  });

  it("accepts inline kubeconfig", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: false,
      kubeconfig: "apiVersion: v1\nkind: Config\n",
    });
    expect(parsed.kubeconfig).toContain("apiVersion");
  });

  it("rejects when neither inCluster nor any kubeconfig source is set", () => {
    expect(() => parseKubernetesProviderConfig({ inCluster: false })).toThrow(
      /requires one of `inCluster` or `kubeconfig`/,
    );
  });

  it("rejects invalid companySlug", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, companySlug: "INVALID UPPER" }),
    ).toThrow();
  });

  it("rejects egressAllowCidrs entries that are not valid CIDR", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, egressAllowCidrs: ["not-a-cidr"] }),
    ).toThrow(/CIDR/i);
  });

  it("accepts imageRegistry without a URL scheme", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: true,
      imageRegistry: "registry.example.com:5000/paperclip",
    });
    expect(parsed.imageRegistry).toBe("registry.example.com:5000/paperclip");
  });

  it("strips a legacy URL scheme and trailing slash from imageRegistry", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: true,
      imageRegistry: "https://registry.example.com/paperclip/",
    });
    expect(parsed.imageRegistry).toBe("registry.example.com/paperclip");
  });

  it("treats a blank imageRegistry / runtimeImage as unset", () => {
    const parsed = parseKubernetesProviderConfig({ inCluster: true, imageRegistry: "  ", runtimeImage: "" });
    expect(parsed.imageRegistry).toBeUndefined();
    expect(parsed.runtimeImage).toBeUndefined();
    expect(parsed.runtimeImages).toEqual({});
  });

  it("accepts custom runtime images", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: true,
      runtimeImage: "alpine:latest",
      runtimeImages: { codex_local: "registry.example.com/team/codex@sha256:abc123" },
    });
    expect(parsed.runtimeImage).toBe("alpine:latest");
    expect(parsed.runtimeImages).toEqual({ codex_local: "registry.example.com/team/codex@sha256:abc123" });
  });

  it("rejects runtime images with a URL scheme", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, runtimeImage: "https://alpine:latest" }),
    ).toThrow(/URL scheme/);
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, runtimeImages: { claude_local: "https://x/y:1" } }),
    ).toThrow(/URL scheme/);
  });
});
