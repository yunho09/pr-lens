import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildClaudeArgs,
  childEnv,
  ClaudeError,
  killAllClaudeGroups,
  runClaude,
  interpretClaudeResult,
  parseClaudeOutput,
  StreamJsonReader,
  toCliJsonSchema,
} from "./claude";
import { triageOutputSchema } from "./triage-schema";
import type { Activity } from "./types";

const valid = { summary: "요약", readingOrder: [], items: [] };

function out(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", ...fields });
}

describe("toCliJsonSchema", () => {
  it("produces a plain schema without $schema or safe-integer bounds", () => {
    const schema = toCliJsonSchema(triageOutputSchema);
    const text = JSON.stringify(schema);
    expect(schema.$schema).toBeUndefined();
    expect(text).not.toContain("minimum");
    expect(text).not.toContain("maximum");
    expect(schema).toMatchObject({ type: "object", additionalProperties: false, required: ["summary", "readingOrder", "items"] });
    expect(text).toContain('"line":{"type":"integer"}');
    expect(text).toContain('"explain":{"type":"string"}');
    expect(text).toContain('"lookAt"');
  });
});

describe("buildClaudeArgs", () => {
  it("fast mode: json output, no tools, budget cap", () => {
    const args = buildClaudeArgs("SYS", "{}", { deep: false, maxBudgetUsd: 1.5 });
    expect(args).toEqual(expect.arrayContaining(["--output-format", "json", "--tools", "", "--setting-sources"]));
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("1.5");
    expect(buildClaudeArgs("SYS", "{}", { deep: false })).toEqual(expect.arrayContaining(["--max-budget-usd", "3"]));
    expect(args).not.toContain("--restricted");
    expect(args.slice(-4)).toEqual(["--system-prompt", "SYS", "--json-schema", "{}"]);
  });

  it("deep mode: restricted read-only tools, stream-json, budget cap", () => {
    const args = buildClaudeArgs("SYS", "{}", { deep: true, maxBudgetUsd: 2.5, model: "m" });
    expect(args).toContain("--restricted");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2.5");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args.slice(-2)).toEqual(["--model", "m"]);
    expect(args).not.toContain("--bare");
  });
});

describe("parseClaudeOutput", () => {
  it("returns validated structured_output with cost and duration", () => {
    const r = parseClaudeOutput(out({ structured_output: valid, total_cost_usd: 0.05, duration_ms: 1200 }), "", 0, triageOutputSchema);
    expect(r).toEqual({ data: valid, costUsd: 0.05, durationMs: 1200, toolCalls: 0, permissionDenials: 0 });
  });

  it("counts permission denials", () => {
    const r = parseClaudeOutput(
      out({ structured_output: valid, permission_denials: [{ tool_name: "Read", tool_input: { file_path: "/etc/hostname" } }] }),
      "",
      0,
      triageOutputSchema,
    );
    expect(r.permissionDenials).toBe(1);
  });

  it("fails on is_error with the result text", () => {
    expect(() =>
      parseClaudeOutput(out({ is_error: true, result: "Not logged in", structured_output: valid }), "", 0, triageOutputSchema),
    ).toThrow(/Not logged in/);
  });

  it("fails when subtype is not success, with a hint for the budget cap", () => {
    expect(() =>
      parseClaudeOutput(out({ subtype: "error_max_turns", structured_output: valid }), "", 0, triageOutputSchema),
    ).toThrow(/error_max_turns/);
    expect(() =>
      parseClaudeOutput(out({ subtype: "error_max_budget_usd", is_error: true }), "", 1, triageOutputSchema),
    ).toThrow(/PR_LENS_MAX_BUDGET/);
  });

  it("fails on non-zero exit and surfaces stderr when stdout is not JSON", () => {
    expect(() => parseClaudeOutput("", "boom: auth required", 1, triageOutputSchema)).toThrow(/exit 1.*boom: auth required/);
  });

  it("fails when structured_output is missing", () => {
    expect(() => parseClaudeOutput(out({ result: "plain text" }), "", 0, triageOutputSchema)).toThrow(
      /구조화된 결과.*plain text/,
    );
  });

  it("fails when structured_output does not match the schema", () => {
    expect(() =>
      parseClaudeOutput(out({ structured_output: { summary: 1 } }), "", 0, triageOutputSchema),
    ).toThrow(ClaudeError);
  });
});

describe("StreamJsonReader", () => {
  const repo = "/work/repo";
  // Event shapes observed from `claude -p --output-format stream-json --verbose` (CLI 2.1.304).
  const events = [
    { type: "system", subtype: "init", cwd: repo, tools: ["Glob", "Grep", "Read", "StructuredOutput"] },
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: `${repo}/src/use.ts` } }] },
    },
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "looking" },
          { type: "tool_use", id: "t2", name: "Grep", input: { pattern: "checkToken", output_mode: "content" } },
          { type: "tool_use", id: "t3", name: "Glob", input: { pattern: "**/*.test.ts", path: `${repo}/src` } },
        ],
      },
    },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t4", name: "Read", input: { file_path: "/etc/hostname" } }] } },
    { type: "system", subtype: "permission_denied" },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "1\tx" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t5", name: "StructuredOutput", input: valid }] } },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      structured_output: valid,
      total_cost_usd: 0.04,
      duration_ms: 6566,
      permission_denials: [{ tool_name: "Read", tool_input: { file_path: "/etc/hostname" } }],
    },
  ];

  it("emits Read/Grep/Glob activities (not StructuredOutput) and keeps the result event", () => {
    const seen: Activity[] = [];
    const reader = new StreamJsonReader(repo, (a) => seen.push(a));
    const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    // Feed in awkward chunks to exercise line buffering.
    for (let i = 0; i < text.length; i += 37) reader.push(text.slice(i, i + 37));
    reader.end();

    expect(seen).toEqual([
      { tool: "Read", target: "src/use.ts" },
      { tool: "Grep", target: "checkToken" },
      { tool: "Glob", target: "**/*.test.ts (src)" },
      { tool: "Read", target: "/etc/hostname" },
    ]);
    expect(reader.toolCalls).toBe(4);

    const r = interpretClaudeResult(reader.result, "", 0, triageOutputSchema, { toolCalls: reader.toolCalls });
    expect(r).toMatchObject({ data: valid, costUsd: 0.04, durationMs: 6566, toolCalls: 4, permissionDenials: 1 });
  });

  it("handles a final line without a trailing newline and ignores junk lines", () => {
    const reader = new StreamJsonReader(repo);
    reader.push("not json\n");
    reader.push(JSON.stringify(events[events.length - 1]));
    reader.end();
    expect((reader.result as { total_cost_usd: number }).total_cost_usd).toBe(0.04);
  });
});

describe("childEnv", () => {
  it("drops every CLAUDE* variable except the auth/provider/config allowlist, and GitHub tokens", () => {
    const env = childEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      CLAUDECODE: "1",
      CLAUDE_EFFORT: "xhigh",
      CLAUDE_PID: "123",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_CODE_MESSAGING_SOCKET: "/run/x.sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      CLAUDE_CODE_USE_NATIVE_FILE_SEARCH: "1",
      CLAUDE_CONFIG_DIR: "/home/u/.claude-work",
      CLAUDE_CODE_OAUTH_TOKEN: "user-auth",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
      CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH: "1",
      CLAUDE_CODE_CLIENT_CERT: "/c.pem",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_BASE_URL: "https://proxy",
      GITHUB_TOKEN: "ghp_secret",
      GH_TOKEN: "gho_secret",
      PR_LENS_MODEL: "m",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      CLAUDE_CONFIG_DIR: "/home/u/.claude-work",
      CLAUDE_CODE_OAUTH_TOKEN: "user-auth",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
      CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH: "1",
      CLAUDE_CODE_CLIENT_CERT: "/c.pem",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_BASE_URL: "https://proxy",
      PR_LENS_MODEL: "m",
      CLAUDE_WIKI_CAPTURE: "1",
      DISABLE_OMC: "1",
    });
  });
});

describe("runClaude process group", () => {
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    return true;
  }

  it("kills the CLI and its grandchildren when the request is aborted", async () => {
    const bin = await mkdtemp(path.join(os.tmpdir(), "pr-lens-fake-claude-"));
    const pidFile = path.join(bin, "pids");
    // A stand-in CLI that starts a long-running grandchild, like ripgrep behind Grep.
    await writeFile(
      path.join(bin, "claude"),
      `#!/bin/sh\nsleep 300 &\necho "$$ $!" > "${pidFile}"\ncat > /dev/null\nwait\n`,
    );
    await chmod(path.join(bin, "claude"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    try {
      const controller = new AbortController();
      const run = runClaude("SYS", "prompt", triageOutputSchema, { signal: controller.signal });
      let pids: number[] = [];
      for (let i = 0; i < 100 && pids.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 20));
        pids = (await readFile(pidFile, "utf8").catch(() => "")).trim().split(" ").filter(Boolean).map(Number);
      }
      expect(pids).toHaveLength(2);
      const [cli, grandchild] = pids;
      expect(alive(grandchild)).toBe(true);

      controller.abort();
      await expect(run).rejects.toThrow("요청이 취소되었습니다.");
      for (let i = 0; i < 50 && (alive(cli) || alive(grandchild)); i++) await new Promise((r) => setTimeout(r, 50));
      expect(alive(cli)).toBe(false);
      expect(alive(grandchild)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(bin, { recursive: true, force: true });
    }
  });
});

describe("killAllClaudeGroups (used by the SIGINT/SIGTERM/SIGHUP/exit hooks)", () => {
  it("synchronously kills every running CLI group", async () => {
    const bin = await mkdtemp(path.join(os.tmpdir(), "pr-lens-fake-claude-"));
    const pidFile = path.join(bin, "pids");
    await writeFile(
      path.join(bin, "claude"),
      `#!/bin/sh\nsleep 300 &\necho "$$ $!" > "${pidFile}"\ncat > /dev/null\nwait\n`,
    );
    await chmod(path.join(bin, "claude"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      const run = runClaude("SYS", "prompt", triageOutputSchema).catch((e: Error) => e);
      let pids: number[] = [];
      for (let i = 0; i < 100 && pids.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 20));
        pids = (await readFile(pidFile, "utf8").catch(() => "")).trim().split(" ").filter(Boolean).map(Number);
      }
      expect(pids).toHaveLength(2);

      expect(killAllClaudeGroups()).toBe(1);
      expect(await run).toBeInstanceOf(Error); // the CLI died before answering
      for (let i = 0; i < 50 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 20));
      expect(pids.filter(alive)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await rm(bin, { recursive: true, force: true });
    }
  });
});

describe("runClaude launch errors", () => {
  it("names a missing working directory instead of blaming the claude binary", async () => {
    await expect(
      runClaude("SYS", "p", triageOutputSchema, { repoDir: path.join(os.tmpdir(), "pr-lens-no-such-checkout-xyz") }),
    ).rejects.toThrow(/작업 폴더가 없습니다/);
  });

  it("reports a missing binary as such", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "pr-lens-empty-path-"));
    vi.stubEnv("PATH", empty);
    try {
      await expect(runClaude("SYS", "p", triageOutputSchema)).rejects.toThrow(/`claude` 명령을 찾을 수 없습니다/);
    } finally {
      vi.unstubAllEnvs();
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe("runClaude delayed SIGKILL", () => {
  async function fakeCli(script: string) {
    const bin = await mkdtemp(path.join(os.tmpdir(), "pr-lens-fake-claude-"));
    const pidFile = path.join(bin, "pid");
    await writeFile(path.join(bin, "claude"), `#!/bin/sh\necho $$ > "${pidFile}"\n${script}\n`);
    await chmod(path.join(bin, "claude"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    return { bin, pidFile };
  }

  async function waitForPid(pidFile: string): Promise<number> {
    for (let i = 0; i < 200; i++) {
      const text = (await readFile(pidFile, "utf8").catch(() => "")).trim();
      if (text) return Number(text);
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("fake CLI did not start");
  }

  it("is cancelled once the group has exited, so a reused pgid is never killed", async () => {
    const { bin, pidFile } = await fakeCli("sleep 300 & wait");
    try {
      const controller = new AbortController();
      const run = runClaude("SYS", "p", triageOutputSchema, { signal: controller.signal }).catch((e: Error) => e);
      const pid = await waitForPid(pidFile);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const kill = vi.spyOn(process, "kill");
      controller.abort(); // SIGTERM now, SIGKILL scheduled in 3s
      expect(await run).toBeInstanceOf(Error); // the CLI exited on SIGTERM
      expect(kill).toHaveBeenCalledWith(-pid, "SIGTERM");
      // At exit, members still alive (if any) were SIGKILLed right away; after
      // that, nothing may ever be sent to this pgid again.
      const callsAtExit = kill.mock.calls.length;
      vi.advanceTimersByTime(10_000);
      expect(kill.mock.calls.slice(callsAtExit)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await rm(bin, { recursive: true, force: true });
    }
  });

  it("still escalates to SIGKILL when the CLI ignores SIGTERM", async () => {
    const { bin, pidFile } = await fakeCli("trap '' TERM\nwhile :; do sleep 1; done");
    try {
      const controller = new AbortController();
      const run = runClaude("SYS", "p", triageOutputSchema, { signal: controller.signal }).catch((e: Error) => e);
      const pid = await waitForPid(pidFile);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const kill = vi.spyOn(process, "kill");
      controller.abort();
      vi.advanceTimersByTime(3_000);
      expect(kill).toHaveBeenCalledWith(-pid, "SIGKILL");
      expect(await run).toBeInstanceOf(Error);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await rm(bin, { recursive: true, force: true });
    }
  });
});
