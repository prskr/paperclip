import { z } from "zod";
import { adapterRegistrySchema } from "./adapter-registry.js";
import { KNOWN_ADAPTER_TYPES } from "./adapter-defaults.js";

const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

/**
 * Container image references (`registry[:port]/path/name[:tag][@digest]`) are
 * NOT URLs: a scheme such as `https://` makes the kubelet reject the pod with
 * InvalidImageName. Keep this permissive (the kubelet is the final authority)
 * but reject schemes and whitespace up front.
 */
const imageReferenceRegex = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;
const imageReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .refine((v) => !v.includes("://"), {
    message: "Image reference must not include a URL scheme (use e.g. `registry.example.com/org/image:tag`)",
  })
  .refine((v) => imageReferenceRegex.test(v), { message: "Invalid container image reference" });

/**
 * Registry prefix (`host[:port][/path]`) used to rewrite the default runtime
 * images. A leading `http://` / `https://` and trailing slashes are stripped for
 * backwards compatibility with configs saved while this field demanded a URL.
 */
const imageRegistrySchema = z.preprocess(
  (v) =>
    typeof v === "string"
      ? v.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "")
      : v,
  z
    .string()
    .min(1)
    .refine((v) => !v.includes("://"), { message: "Image registry must not include a URL scheme" })
    .refine((v) => /^[A-Za-z0-9][A-Za-z0-9._\-/:]*$/.test(v), {
      message: "Invalid image registry (expected e.g. `registry.example.com/org`)",
    }),
);

/** Treat blank strings (e.g. a cleared UI text field) as "not set". */
function optionalBlank<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    schema.optional(),
  );
}

export const kubernetesProviderConfigSchema = z
  .object({
    inCluster: z.boolean().default(false),
    kubeconfig: z.string().optional(),

    namespacePrefix: z.string().regex(/^[a-z0-9-]{1,32}$/).default("paperclip-"),
    companySlug: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),

    imageRegistry: optionalBlank(imageRegistrySchema),
    /**
     * Optional custom runtime image used for every run in this environment,
     * replacing the adapter default (and the `imageRegistry` rewrite).
     * `runtimeImages[adapterType]` takes precedence when both are set.
     */
    runtimeImage: optionalBlank(imageReferenceSchema),
    /**
     * Optional per-adapter custom runtime images, keyed by adapter type
     * (e.g. `{ "claude_local": "registry.example.com/me/claude:1.2" }`).
     */
    runtimeImages: z.record(imageReferenceSchema).default({}),
    imageAllowList: z.array(z.string()).default([]),
    imagePullSecrets: z.array(z.string()).default([]),

    egressAllowFqdns: z.array(z.string()).default([]),
    egressAllowCidrs: z.array(z.string().regex(cidrRegex, "Invalid CIDR")).default([]),
    egressMode: z.enum(["cilium", "standard"]).default("standard"),

    defaultResources: z
      .object({
        requests: z.object({ cpu: z.string(), memory: z.string() }).partial().optional(),
        limits: z.object({ cpu: z.string(), memory: z.string() }).partial().optional(),
      })
      .optional(),

    runtimeClassName: z.string().optional(),
    serviceAccountAnnotations: z.record(z.string()).default({}),

    jobTtlSecondsAfterFinished: z.number().int().nonnegative().default(900),
    podActivityDeadlineSec: z.number().int().positive().default(3600),

    /**
     * The adapter type that Jobs in this environment will run.
     * Each Kubernetes environment is bound to one adapter; create multiple
     * environments for different adapters.
     * Defaults to `"claude_local"`.
     */
    adapterType: z
      .string()
      .default("claude_local")
      .refine((v) => KNOWN_ADAPTER_TYPES.has(v), {
        message: "adapterType must be one of the known adapter types",
      }),

    /**
     * Optional declarative adapter registry. When present it is authoritative
     * for runtime image / envKeys / allowFqdns / probe / defaultEnv resolution
     * (replace semantics). Absent = built-in defaults.
     */
    adapters: adapterRegistrySchema.optional(),

    /**
     * The sandbox backend to use.
     *
     * - `"sandbox-cr"` (default, alpha) — uses the kubernetes-sigs/agent-sandbox
     *   Sandbox CRD (agents.x-k8s.io/v1alpha1). Creates a long-lived pod that
     *   paperclip-server can exec into for multi-command adapter-install workflows.
     *   Requires the agent-sandbox controller to be installed in the cluster.
     *
     * - `"job"` — uses batch/v1 Job (stable fallback). One-shot entrypoint; does
     *   NOT support multi-command exec. Use this for clusters without agent-sandbox
     *   installed, or when you need stable (non-alpha) k8s APIs.
     */
    backend: z.enum(["sandbox-cr", "job"]).default("sandbox-cr"),
  })
  .refine(
    (cfg) => cfg.inCluster || cfg.kubeconfig,
    {
      message:
        "kubernetes provider requires one of `inCluster` or `kubeconfig`",
    },
  );

export type KubernetesProviderConfig = z.infer<typeof kubernetesProviderConfigSchema>;

export function parseKubernetesProviderConfig(input: unknown): KubernetesProviderConfig {
  return kubernetesProviderConfigSchema.parse(input);
}

export interface KubernetesLeaseMetadata {
  namespace: string;
  /** Name of the workload resource (Job name for job backend, Sandbox CR name for sandbox-cr backend). */
  jobName: string;
  podName: string | null;
  secretName: string;
  phase: "Pending" | "Running" | "Succeeded" | "Failed";
  /** Which backend provisioned this lease. */
  backend: "sandbox-cr" | "job";
  /**
   * The Sandbox API version this lease was created with, for the sandbox-cr
   * backend. Release and destroy read it so cleanup deletes the resource with
   * the version that created it, and does not depend on API discovery being
   * reachable at that moment. Absent on a job-backend lease, and on a lease
   * created before this field existed.
   */
  sandboxApiVersion?: string | null;
  scopedNetworkPolicyName: string | null;
  scopedNetworkEgress: {
    allowFqdns: string[];
    allowCidrs: string[];
  };
  /**
   * True when this lease's backend has NO data channel for the native file-sync
   * transport. Native sync streams over a pod exec, which only the `sandbox-cr`
   * backend exposes; the `job` backend carries no exec path, so its sync hook
   * rejects immediately. The server's per-lease sync-capability gate honors this
   * opt-out so a job lease keeps the byte-identical base64 fallback instead of
   * being routed to a native hook that would only error. Absent/false ⇒ native
   * sync may be used when the worker advertises the verbs.
   */
  nativeFileSyncUnsupported?: boolean;
}
