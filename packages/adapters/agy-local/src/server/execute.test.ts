import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import { runChildProcess, type RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import { discoverAgySessionArtifacts, execute, modelHasEffortSuffix, resolveAgyPrintTimeoutSec } from "./execute.js";
import { DENIED_ACTION_RUN, SIMPLE_RUN, TOOL_ERROR_RECOVERED_RUN } from "./fixtures.test-util.js";

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable: vi.fn(async () => {}),
    runChildProcess: vi.fn(async (input: { command: string; args?: string[] }) => {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({ event: "init", conversation_id: "conv-fresh-1" }) + "\n" +
          JSON.stringify({ event: "result", result: { status: "SUCCESS", conversation_id: "conv-fresh-1" } }) + "\n",
        stderr: "",
      };
    }),
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => {}),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async (cmd: string) => cmd),
  };
});

describe("agy-local execute", () => {
  it("passes configured mode, model, and effort to agy CLI arguments", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          mode: "plan",
          model: "claude-sonnet-4-6",
          effort: "high",
          dangerouslySkipPermissions: true,
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("conv-fresh-1");

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--mode");
    expect(commandArgs[commandArgs.indexOf("--mode") + 1]).toBe("plan");
    expect(commandArgs).toContain("--model");
    expect(commandArgs[commandArgs.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
    expect(commandArgs).toContain("--effort");
    expect(commandArgs[commandArgs.indexOf("--effort") + 1]).toBe("high");
    expect(commandArgs).toContain("--dangerously-skip-permissions");
  });

  it("omits --effort when model already contains an effort suffix matching requested effort", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-model-effort-suffix",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          model: "gemini-3.8-flash-high",
          effort: "high",
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--model");
    expect(commandArgs[commandArgs.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
    expect(commandArgs).not.toContain("--effort");
  });

  it("updates suffixed model to match effort override without passing conflicting --effort", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-model-effort-override",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          model: "gemini-3.8-flash-high",
          effort: "low",
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("gemini-3.8-flash-low");

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--model");
    expect(commandArgs[commandArgs.indexOf("--model") + 1]).toBe("gemini-3.8-flash-low");
    expect(commandArgs).not.toContain("--effort");
  });

  it("does not rewrite model to an invalid model ID when effort override is not supported by that model family", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;
    const logs: string[] = [];

    const ctx: AdapterExecutionContext = {
      runId: "run-model-effort-override-unsupported",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          model: "gpt-oss-120b-medium",
          effort: "high",
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async (_stream, text) => {
        logs.push(text);
      },
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("gpt-oss-120b-medium");

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--model");
    expect(commandArgs[commandArgs.indexOf("--model") + 1]).toBe("gpt-oss-120b-medium");
    expect(commandArgs).not.toContain("--effort");
    expect(logs.join("")).toContain('Warning: Model "gpt-oss-120b-medium" does not have a "high" variant; running with "gpt-oss-120b-medium".');
  });

  it("preserves uncataloged effort-suffixed models and emits a warning when requested effort variant is not recognized", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;
    const logs: string[] = [];

    const ctx: AdapterExecutionContext = {
      runId: "run-model-custom-effort-override",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          model: "custom-preview-model-high",
          effort: "low",
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async (_stream, text) => {
        logs.push(text);
      },
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("custom-preview-model-high");

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--model");
    expect(commandArgs[commandArgs.indexOf("--model") + 1]).toBe("custom-preview-model-high");
    expect(commandArgs).not.toContain("--effort");
    expect(logs.join("")).toContain('Warning: Model "custom-preview-model-high" does not have a "low" variant; running with "custom-preview-model-high".');
  });

  it("passes --conversation when resuming a previous session", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-2",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          dangerouslySkipPermissions: true,
        },
      },
      runtime: {
        sessionId: "conv-prior-1",
        sessionParams: {
          sessionId: "conv-prior-1",
          cwd: "/tmp/workspace",
        },
        sessionDisplayId: "conv-prior-1",
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--conversation");
    expect(commandArgs[commandArgs.indexOf("--conversation") + 1]).toBe("conv-prior-1");
  });

  it("passes multi-workspace --add-dir, --agent, --sandbox, and --json-schema", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-3",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          agent: "flutter_a11y_agent",
          sandbox: true,
          jsonSchema: '{"type":"object"}',
          addDirs: ["/tmp/extra-repo"],
          dangerouslySkipPermissions: true,
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/main-workspace",
        },
        paperclipWorkspaces: [
          { cwd: "/tmp/main-workspace" },
          { cwd: "/tmp/second-workspace" },
        ],
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];

    // Verify --add-dir contains main-workspace, second-workspace, and extra-repo
    const addDirIndices: number[] = [];
    commandArgs.forEach((arg, idx) => {
      if (arg === "--add-dir") addDirIndices.push(idx + 1);
    });
    const addDirValues = addDirIndices.map((i) => commandArgs[i]);
    expect(addDirValues).toContain("/tmp/main-workspace");
    expect(addDirValues).toContain("/tmp/second-workspace");
    expect(addDirValues).toContain("/tmp/extra-repo");

    // Verify agent, sandbox, jsonSchema
    expect(commandArgs).toContain("--agent");
    expect(commandArgs[commandArgs.indexOf("--agent") + 1]).toBe("flutter_a11y_agent");
    expect(commandArgs).toContain("--sandbox");
    expect(commandArgs).toContain("--json-schema");
    expect(commandArgs[commandArgs.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
  });

  it("omits --dangerously-skip-permissions by default when dangerouslySkipPermissions is omitted", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-5",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).not.toContain("--dangerously-skip-permissions");
  });

  it("omits --dangerously-skip-permissions when dangerouslySkipPermissions is false", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-4",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          dangerouslySkipPermissions: false,
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).not.toContain("--dangerously-skip-permissions");
  });

  it("does not pass --mode when mode is omitted (defaults to edit mode)", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-default-mode",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).not.toContain("--mode");
  });

  it("passes --mode accept-edits when mode is explicitly set to accept-edits", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-accept-edits-mode",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          mode: "accept-edits",
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--mode");
    expect(commandArgs[commandArgs.indexOf("--mode") + 1]).toBe("accept-edits");
  });

  it("passes --project, --print-timeout, and --disable-slash-commands when configured", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-custom-flags",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          project: "paperclip-core",
          printTimeout: "45m",
          disableSlashCommands: true,
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--project");
    expect(commandArgs[commandArgs.indexOf("--project") + 1]).toBe("paperclip-core");
    expect(commandArgs).toContain("--print-timeout");
    expect(commandArgs[commandArgs.indexOf("--print-timeout") + 1]).toBe("45m");
    expect(commandArgs).toContain("--disable-slash-commands");
  });

  it("defaults --print-timeout to 24h when timeoutSec is 0 or aligns to timeoutSec", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;

    const ctx: AdapterExecutionContext = {
      runId: "run-timeout-align",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          timeoutSec: 360,
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    expect(capturedMeta).not.toBeNull();
    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--print-timeout");
    expect(commandArgs[commandArgs.indexOf("--print-timeout") + 1]).toBe("360s");
  });
});

describe("agy-local execute run outcome", () => {
  const runWithOutput = async (stdout: string, stderr = "", exitCode = 0) => {
    vi.mocked(runChildProcess).mockResolvedValueOnce({
      exitCode,
      signal: null,
      timedOut: false,
      stdout,
      stderr,
    } as Awaited<ReturnType<typeof runChildProcess>>);
    const logs: string[] = [];
    const result = await execute({
      runId: "run-outcome",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {},
      context: { paperclipWorkspace: { cwd: "/tmp/workspace" } },
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });
    return { result, logs: logs.join("") };
  };

  it("reports a SUCCESS run as succeeded despite a recovered tool error and auth-like transcript text", async () => {
    const stdout = TOOL_ERROR_RECOVERED_RUN.replace(
      '"text_delta":"RECOVERED"',
      '"text_delta":"No unauthenticated endpoints; no 401 or 429 responses found. RECOVERED"',
    );
    const { result } = await runWithOutput(stdout);
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toBe("RECOVERED");
  });

  it("fails an auto-denied run with agy_permission_denied and logs how to fix it", async () => {
    const { result, logs } = await runWithOutput(DENIED_ACTION_RUN);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("agy_permission_denied");
    expect(result.errorMessage).toMatch(/WriteToFile/);
    expect(result.summary).toBe(result.errorMessage);
    expect(logs).toMatch(/auto-denied 1 tool action\(s\): WriteToFile/);
  });

  it("returns no summary for a successful run with an empty response", async () => {
    const stdout = SIMPLE_RUN.replace(/"text_delta":"[^"]*"/g, '"text_delta":""').replace(
      '"response":"HELLO_AGY\\n"',
      '"response":""',
    );
    const { result } = await runWithOutput(stdout);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBeNull();
  });

  it("keeps a run that answered after a denied action successful but still logs the denial", async () => {
    const stdout = DENIED_ACTION_RUN.replace('"response":""', '"response":"Wrote the text into my reply instead."');
    const { result, logs } = await runWithOutput(stdout);
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeNull();
    expect(logs).toMatch(/auto-denied 1 tool action\(s\): WriteToFile/);
  });

  it("still classifies a real authentication failure from the terminal result", async () => {
    const { result } = await runWithOutput(
      '{"event":"result","result":{"status":"ERROR","error":"not authenticated: please sign in"}}',
    );
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("agy_auth_required");
    expect(result.errorMessage).toBe("not authenticated: please sign in");
  });

  it("streams prompt via stdin NDJSON with --input-format stream-json by default, avoiding --print argv", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;
    vi.mocked(runChildProcess).mockClear();

    const ctx: AdapterExecutionContext = {
      runId: "run-stream-json",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--input-format");
    expect(commandArgs[commandArgs.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(commandArgs).not.toContain("--print");

    const calls = vi.mocked(runChildProcess).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCallOptions = calls[calls.length - 1][3] as { stdin?: string };
    expect(lastCallOptions?.stdin).toBeDefined();
    const parsedStdin = JSON.parse(lastCallOptions.stdin!.trim());
    expect(parsedStdin.event).toBe("user");
    expect(parsedStdin.message.content).toBeDefined();
  });

  it("falls back to --print argv when inputFormat is explicitly configured as text", async () => {
    let capturedMeta: AdapterInvocationMeta | null = null;
    vi.mocked(runChildProcess).mockClear();

    const ctx: AdapterExecutionContext = {
      runId: "run-text-input",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {
          inputFormat: "text",
        },
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => {
        capturedMeta = meta;
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    const commandArgs = capturedMeta!.commandArgs as string[];
    expect(commandArgs).toContain("--input-format");
    expect(commandArgs[commandArgs.indexOf("--input-format") + 1]).toBe("text");
    expect(commandArgs).toContain("--print");

    const calls = vi.mocked(runChildProcess).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCallOptions = calls[calls.length - 1][3] as { stdin?: string };
    expect(lastCallOptions?.stdin).toBeUndefined();
  });

  describe("pre-turn auth failure executionRecovery", () => {
    const authFailureCtx: AdapterExecutionContext = {
      runId: "run-auth-test",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "agy_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/workspace",
        },
      },
      onLog: async () => {},
    };

    function makeProcResult(override: Partial<RunProcessResult> = {}): RunProcessResult {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
        ...override,
      };
    }

    it("marks pre-turn auth failure with bootstrap executionRecovery when no provider work started", async () => {
      vi.mocked(runChildProcess).mockResolvedValueOnce(
        makeProcResult({
          stdout:
            JSON.stringify({
              event: "result",
              result: {
                conversation_id: "",
                status: "ERROR",
                error: "authentication failed or timed out",
                num_turns: 0,
                usage: { total_tokens: 0 },
              },
            }) + "\n",
        }),
      );

      const result = await execute(authFailureCtx);
      expect(result.errorCode).toBe("agy_auth_required");
      expect(result.executionRecovery).toEqual({
        kind: "bootstrap",
        providerWorkStarted: false,
      });
      expect(
        (result.resultJson as Record<string, unknown> | undefined)?.executionRecovery,
      ).toEqual({
        kind: "bootstrap",
        providerWorkStarted: false,
      });
    });

    it("does not set bootstrap executionRecovery when a tool event was parsed", async () => {
      vi.mocked(runChildProcess).mockResolvedValueOnce(
        makeProcResult({
          stdout: [
            JSON.stringify({
              event: "step_update",
              step_update: {
                conversation_id: "",
                step_index: 1,
                state: "DONE",
                step_type: "tool",
                tool_name: "view_file",
                tool_info: {
                  name: "view_file",
                  parameters: { AbsolutePath: "/tmp/file.txt" },
                  output: "content",
                },
              },
            }),
            JSON.stringify({
              event: "result",
              result: {
                conversation_id: "",
                status: "ERROR",
                error: "authentication failed or timed out",
                num_turns: 0,
                usage: { total_tokens: 0 },
              },
            }),
          ].join("\n") + "\n",
        }),
      );

      const result = await execute(authFailureCtx);
      expect(result.errorCode).toBe("agy_auth_required");
      expect(result.executionRecovery).toBeUndefined();
      expect(
        (result.resultJson as Record<string, unknown> | undefined)?.executionRecovery,
      ).toBeUndefined();
    });

    it("does not set bootstrap executionRecovery when non-zero tokens were parsed", async () => {
      vi.mocked(runChildProcess).mockResolvedValueOnce(
        makeProcResult({
          stdout:
            JSON.stringify({
              event: "result",
              result: {
                conversation_id: "",
                status: "ERROR",
                error: "authentication failed or timed out",
                num_turns: 0,
                usage: { input_tokens: 15, output_tokens: 0, total_tokens: 15 },
              },
            }) + "\n",
        }),
      );

      const result = await execute(authFailureCtx);
      expect(result.errorCode).toBe("agy_auth_required");
      expect(result.executionRecovery).toBeUndefined();
      expect(
        (result.resultJson as Record<string, unknown> | undefined)?.executionRecovery,
      ).toBeUndefined();
    });

    it("does not set bootstrap executionRecovery when non-zero total_tokens was parsed", async () => {
      vi.mocked(runChildProcess).mockResolvedValueOnce(
        makeProcResult({
          stdout:
            JSON.stringify({
              event: "result",
              result: {
                conversation_id: "",
                status: "ERROR",
                error: "authentication failed or timed out",
                num_turns: 0,
                usage: { total_tokens: 25 },
              },
            }) + "\n",
        }),
      );

      const result = await execute(authFailureCtx);
      expect(result.errorCode).toBe("agy_auth_required");
      expect(result.executionRecovery).toBeUndefined();
    });

    it("does not set bootstrap executionRecovery when session id is present", async () => {
      vi.mocked(runChildProcess).mockResolvedValueOnce(
        makeProcResult({
          stdout:
            JSON.stringify({
              event: "result",
              result: {
                conversation_id: "conv-12345",
                status: "ERROR",
                error: "authentication failed or timed out",
                num_turns: 0,
                usage: { total_tokens: 0 },
              },
            }) + "\n",
        }),
      );

      const result = await execute(authFailureCtx);
      expect(result.errorCode).toBe("agy_auth_required");
      expect(result.executionRecovery).toBeUndefined();
    });

    it("does not set bootstrap executionRecovery when num_turns > 0", async () => {
      vi.mocked(runChildProcess).mockResolvedValueOnce(
        makeProcResult({
          stdout:
            JSON.stringify({
              event: "result",
              result: {
                conversation_id: "",
                status: "ERROR",
                error: "authentication failed or timed out",
                num_turns: 1,
                usage: { total_tokens: 0 },
              },
            }) + "\n",
        }),
      );

      const result = await execute(authFailureCtx);
      expect(result.errorCode).toBe("agy_auth_required");
      expect(result.executionRecovery).toBeUndefined();
    });

    it("does not set bootstrap executionRecovery when assistant event was parsed", async () => {
      vi.mocked(runChildProcess).mockResolvedValueOnce(
        makeProcResult({
          stdout: [
            JSON.stringify({
              event: "step_update",
              step_update: {
                conversation_id: "",
                step_index: 1,
                state: "ACTIVE",
                step_type: "agent_response",
                text_delta: "Hello",
              },
            }),
            JSON.stringify({
              event: "result",
              result: {
                conversation_id: "",
                status: "ERROR",
                error: "authentication failed or timed out",
                num_turns: 0,
                usage: { total_tokens: 0 },
              },
            }),
          ].join("\n") + "\n",
        }),
      );

      const result = await execute(authFailureCtx);
      expect(result.errorCode).toBe("agy_auth_required");
      expect(result.executionRecovery).toBeUndefined();
    });

    it("does not set bootstrap executionRecovery on timeout even if auth error detected", async () => {
      vi.mocked(runChildProcess).mockResolvedValueOnce(
        makeProcResult({
          exitCode: null,
          signal: "SIGKILL",
          timedOut: true,
          stdout: "",
          stderr: "authentication failed or timed out",
        }),
      );

      const result = await execute(authFailureCtx);
      expect(result.timedOut).toBe(true);
      expect(result.errorCode).toBe("agy_auth_required");
      expect(result.executionRecovery).toBeUndefined();
    });
  });
});

describe("discoverAgySessionArtifacts", () => {
  it("returns empty array for invalid or missing sessionId", async () => {
    expect(await discoverAgySessionArtifacts("")).toEqual([]);
    expect(await discoverAgySessionArtifacts("non-existent-conv-id-99999")).toEqual([]);
  });
});

describe("modelHasEffortSuffix and resolveAgyPrintTimeoutSec", () => {
  it("modelHasEffortSuffix detects effort-suffixed model ids", () => {
    expect(modelHasEffortSuffix("gemini-3.6-flash-high")).toBe(true);
    expect(modelHasEffortSuffix("gemini-3.6-flash-medium")).toBe(true);
    expect(modelHasEffortSuffix("gpt-oss-120b-medium")).toBe(true);
    expect(modelHasEffortSuffix("auto")).toBe(false);
    expect(modelHasEffortSuffix("claude-sonnet-4-6")).toBe(false);
    expect(modelHasEffortSuffix("claude-opus-4-6-thinking")).toBe(false);
  });

  it("agy's print timeout stays under the Paperclip run timeout when resolved", () => {
    expect(resolveAgyPrintTimeoutSec(3600)).toBeLessThan(3600);
    expect(resolveAgyPrintTimeoutSec(3600)).toBe(3420);
    expect(resolveAgyPrintTimeoutSec(120)).toBe(110);
    expect(resolveAgyPrintTimeoutSec(10)).toBe(30);
    expect(resolveAgyPrintTimeoutSec(0)).toBe(0);
  });
});
