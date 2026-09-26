/**
 * API version discovery for the kubernetes-sigs/agent-sandbox Sandbox CRD.
 *
 * agent-sandbox v0.5.x serves `agents.x-k8s.io/v1beta1` (and, during the
 * storage migration window, still `v1alpha1`); v0.4.x only serves `v1alpha1`;
 * newer releases dropped `v1alpha1` entirely. The Sandbox spec fields this
 * plugin uses (podTemplate, status.conditions) are identical in both versions,
 * so only the apiVersion on the wire has to match what the cluster serves.
 *
 * resolveSandboxApiVersion() asks the API server's discovery endpoint which
 * versions of the group are served and picks the most preferred one we
 * support (v1beta1 first, then v1alpha1). The result is cached per cluster.
 */

import type { KubeClients } from "./kube-client.js";

export const SANDBOX_GROUP = "agents.x-k8s.io";
export const SANDBOX_PLURAL = "sandboxes";

/** Supported Sandbox API versions, most preferred first. */
export const SUPPORTED_SANDBOX_VERSIONS = ["v1beta1", "v1alpha1"] as const;
export type SandboxApiVersion = (typeof SUPPORTED_SANDBOX_VERSIONS)[number];

/**
 * Used when discovery is unavailable (no discovery client, request failed,
 * or the group is not installed). In the latter case the subsequent CR call
 * surfaces the natural 404 exactly as before discovery existed.
 */
export const DEFAULT_SANDBOX_VERSION: SandboxApiVersion = "v1beta1";

/** Re-discover periodically so an in-place agent-sandbox upgrade is picked up. */
const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  version: SandboxApiVersion;
  expiresAt: number;
}

// Keyed by API server URL when known, else by the clients object itself.
const cacheByServer = new Map<string, CacheEntry>();
const cacheByClients = new WeakMap<object, CacheEntry>();

function readCache(clients: KubeClients): CacheEntry | undefined {
  const entry = clients.server
    ? cacheByServer.get(clients.server)
    : cacheByClients.get(clients);
  return entry && entry.expiresAt > Date.now() ? entry : undefined;
}

function writeCache(clients: KubeClients, version: SandboxApiVersion): void {
  const entry = { version, expiresAt: Date.now() + CACHE_TTL_MS };
  if (clients.server) cacheByServer.set(clients.server, entry);
  else cacheByClients.set(clients, entry);
}

/** Test hook: forget all discovered versions. */
export function resetSandboxApiVersionCache(): void {
  cacheByServer.clear();
}

export function isSupportedSandboxVersion(value: unknown): value is SandboxApiVersion {
  return (SUPPORTED_SANDBOX_VERSIONS as readonly unknown[]).includes(value);
}

/** "agents.x-k8s.io/v1beta1" for a given version. */
export function sandboxApiVersionString(version: SandboxApiVersion): string {
  return `${SANDBOX_GROUP}/${version}`;
}

/**
 * Picks the most preferred supported version out of the versions a cluster
 * serves for the agents.x-k8s.io group. Returns null when none is supported.
 */
export function pickSandboxVersion(served: readonly string[]): SandboxApiVersion | null {
  return SUPPORTED_SANDBOX_VERSIONS.find((v) => served.includes(v)) ?? null;
}

export class UnsupportedSandboxApiVersionError extends Error {
  constructor(served: readonly string[]) {
    super(
      `Cluster serves ${SANDBOX_GROUP} versions [${served.join(", ")}], none of which is supported ` +
        `(supported: ${SUPPORTED_SANDBOX_VERSIONS.join(", ")})`,
    );
    this.name = "UnsupportedSandboxApiVersionError";
  }
}

/**
 * Discovers which Sandbox API version to talk to on this cluster: v1beta1 if
 * served, otherwise v1alpha1. Throws UnsupportedSandboxApiVersionError when
 * the group is installed but serves only unknown versions.
 */
export async function resolveSandboxApiVersion(clients: KubeClients): Promise<SandboxApiVersion> {
  const cached = readCache(clients);
  if (cached) return cached.version;

  if (!clients.apis) return DEFAULT_SANDBOX_VERSION;

  let groups: { name?: string; versions?: { version?: string }[] }[];
  try {
    const result = await clients.apis.getAPIVersions();
    groups = result.groups ?? [];
  } catch {
    // Discovery is readable by every authenticated user by default
    // (system:discovery), so a failure here is transient or an unusual RBAC
    // setup. Don't cache it; fall back and retry discovery next call.
    return DEFAULT_SANDBOX_VERSION;
  }

  const group = groups.find((g) => g.name === SANDBOX_GROUP);
  if (!group) return DEFAULT_SANDBOX_VERSION;

  const served = (group.versions ?? [])
    .map((v) => v.version)
    .filter((v): v is string => typeof v === "string");
  const version = pickSandboxVersion(served);
  if (!version) throw new UnsupportedSandboxApiVersionError(served);

  writeCache(clients, version);
  return version;
}
