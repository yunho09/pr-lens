import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ACTIVITY_TOOLS, type Activity, type ActivityTool } from "./types";

// Thin wrapper around the locally logged-in Claude Code CLI in headless mode.
// Mock it (inject a RunClaude) in tests.

export interface ClaudeRunResult<T> {
  data: T;
  costUsd: number | null;
  durationMs: number | null;
  /** Read/Grep/Glob calls (deep mode only; 0 in fast mode). */
  toolCalls: number;
  /** Tool calls the CLI refused, e.g. reads outside the checkout. */
  permissionDenials: number;
}

export interface RunClaudeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Deep mode: run inside this checkout with read-only tools confined to it. */
  repoDir?: string;
  maxBudgetUsd?: number;
  onActivity?: (activity: Activity) => void;
}

export type RunClaude = <T>(
  system: string,
  prompt: string,
  schema: z.ZodType<T>,
  options?: RunClaudeOptions,
) => Promise<ClaudeRunResult<T>>;

export const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_BUDGET_USD = 3;
const SAFE_INT = Number.MAX_SAFE_INTEGER;

export class ClaudeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeError";
  }
}

/** Plain JSON schema for --json-schema: no $schema, no safe-integer bounds zod adds for z.int(). */
export function toCliJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    override(ctx) {
      const s = ctx.jsonSchema as Record<string, unknown>;
      if (s.minimum === -SAFE_INT) delete s.minimum;
      if (s.maximum === SAFE_INT) delete s.maximum;
    },
  }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/**
 * CLAUDE* variables the child keeps: the user's own config location, auth,
 * provider selection and mTLS settings (from the CLI's auth/provider options).
 * Every other CLAUDE* variable (parent session markers such as CLAUDECODE,
 * CLAUDE_CODE_SESSION_ID, CLAUDE_EFFORT, ...) is dropped. ANTHROPIC_* is left alone.
 */
const KEEP_CLAUDE_VARS = new Set([
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_GATEWAY_TOKEN",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  "CLAUDE_CODE_CERT_STORE",
]);
const KEEP_CLAUDE_PATTERNS = [/^CLAUDE_CODE_SKIP_[A-Z0-9_]+_AUTH$/];
const DROP_ALWAYS = new Set(["GITHUB_TOKEN", "GH_TOKEN"]);

function keepClaudeVar(key: string): boolean {
  return KEEP_CLAUDE_VARS.has(key) || KEEP_CLAUDE_PATTERNS.some((re) => re.test(key));
}

/** Environment for the CLI child: no parent-session CLAUDE* variables and no GitHub token. */
export function childEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (DROP_ALWAYS.has(key)) continue;
    if (key.startsWith("CLAUDE") && !keepClaudeVar(key)) continue;
    out[key] = value;
  }
  // Keep the user's global hooks (wiki capture, OMC) from firing on every call.
  out.CLAUDE_WIKI_CAPTURE = "1";
  out.DISABLE_OMC = "1";
  return out;
}

/**
 * Process groups of running CLI children. Kept on globalThis so a dev-server
 * module reload shares one registry and one set of signal handlers.
 */
interface GroupRegistry {
  groups: Set<number>;
  installed: boolean;
}
const registry: GroupRegistry = ((globalThis as { __prLensClaudeGroups?: GroupRegistry }).__prLensClaudeGroups ??= {
  groups: new Set<number>(),
  installed: false,
});

export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function killGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already gone.
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Synchronously SIGKILLs every tracked CLI process group. Returns how many were signalled. */
export function killAllClaudeGroups(): number {
  const n = registry.groups.size;
  for (const group of registry.groups) killGroup(group, "SIGKILL");
  registry.groups.clear();
  return n;
}

function onShutdownSignal(signal: NodeJS.Signals) {
  killAllClaudeGroups();
  // If nothing else (e.g. Next's own handler) handles this signal, restore the
  // default behaviour so Ctrl-C / SIGTERM / SIGHUP still stop the process.
  if (process.listenerCount(signal) === 1) {
    for (const s of SHUTDOWN_SIGNALS) process.removeListener(s, onShutdownSignal);
    registry.installed = false;
    process.kill(process.pid, signal);
  }
}

function trackGroup(pid: number) {
  registry.groups.add(pid);
  if (!registry.installed) {
    registry.installed = true;
    process.once("exit", killAllClaudeGroups);
    for (const s of SHUTDOWN_SIGNALS) process.on(s, onShutdownSignal);
  }
}

export function maxBudgetFromEnv(): number {
  const n = Number(process.env.PR_LENS_MAX_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BUDGET_USD;
}

/** CLI arguments. Deep mode adds read-only repo tools confined to cwd by --restricted. */
export function buildClaudeArgs(
  system: string,
  jsonSchema: string,
  options: { deep: boolean; maxBudgetUsd?: number; model?: string },
): string[] {
  const common = [
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--max-budget-usd", String(options.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD),
  ];
  const args = options.deep
    ? [
        "-p",
        "--restricted",
        "--output-format", "stream-json",
        "--verbose",
        "--tools", "Read,Grep,Glob",
        "--permission-mode", "dontAsk",
        ...common,
      ]
    : ["-p", "--output-format", "json", "--tools", "", ...common];
  args.push("--system-prompt", system, "--json-schema", jsonSchema);
  if (options.model) args.push("--model", options.model);
  return args;
}

function snippet(text: string | undefined, max = 600): string {
  const t = (text ?? "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const cliResultSchema = z.object({
  is_error: z.boolean().optional(),
  subtype: z.string().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  total_cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  permission_denials: z.array(z.unknown()).optional(),
});

/**
 * Interprets the CLI's final result object (the whole stdout for
 * `--output-format json`, the `type:"result"` event for stream-json).
 * Throws ClaudeError on any failure.
 */
export function interpretClaudeResult<T>(
  raw: unknown,
  stderr: string,
  exitCode: number | null,
  schema: z.ZodType<T>,
  extra: { toolCalls?: number; rawText?: string } = {},
): ClaudeRunResult<T> {
  const checked = raw === undefined ? null : cliResultSchema.safeParse(raw);
  const parsed = checked?.success ? checked.data : null;

  if (!parsed) {
    const detail = snippet(stderr) || snippet(extra.rawText) || "출력 없음";
    throw new ClaudeError(
      exitCode !== 0
        ? `Claude CLI가 실패했습니다 (exit ${exitCode}): ${detail}`
        : `Claude CLI 출력을 해석하지 못했습니다: ${detail}`,
    );
  }

  if (exitCode !== 0 || parsed.is_error === true || parsed.subtype !== "success") {
    const detail = snippet(parsed.result) || snippet(stderr) || "자세한 정보 없음";
    const budgetHint = parsed.subtype?.includes("budget")
      ? " 비용 한도(PR_LENS_MAX_BUDGET)를 넘어 중단되었습니다."
      : "";
    throw new ClaudeError(
      `Claude 응답 오류 (exit ${exitCode}, ${parsed.subtype ?? "unknown"}):${budgetHint} ${detail}`,
    );
  }

  if (parsed.structured_output === undefined || parsed.structured_output === null) {
    throw new ClaudeError(
      `Claude가 구조화된 결과를 반환하지 않았습니다: ${snippet(parsed.result) || "결과 없음"}`,
    );
  }

  const validated = schema.safeParse(parsed.structured_output);
  if (!validated.success) {
    const issues = validated.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ClaudeError(`Claude 결과 형식이 올바르지 않습니다: ${issues}`);
  }

  return {
    data: validated.data,
    costUsd: parsed.total_cost_usd ?? null,
    durationMs: parsed.duration_ms ?? null,
    toolCalls: extra.toolCalls ?? 0,
    permissionDenials: parsed.permission_denials?.length ?? 0,
  };
}

/** `--output-format json`: stdout is a single JSON object. */
export function parseClaudeOutput<T>(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  schema: z.ZodType<T>,
): ClaudeRunResult<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    raw = undefined;
  }
  return interpretClaudeResult(raw, stderr, exitCode, schema, { rawText: stdout });
}

function activityFromToolUse(name: string, input: Record<string, unknown>, repoDir: string): Activity | null {
  if (!(ACTIVITY_TOOLS as readonly string[]).includes(name)) return null;
  const tool = name as ActivityTool;
  if (tool === "Read") {
    const file = typeof input.file_path === "string" ? input.file_path : "";
    const rel = path.isAbsolute(file) ? path.relative(repoDir, file) : file;
    return { tool, target: rel && !rel.startsWith("..") ? rel : file };
  }
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const where = typeof input.path === "string" && input.path ? ` (${path.relative(repoDir, path.resolve(repoDir, input.path)) || "."})` : "";
  return { tool, target: `${pattern}${where}` };
}

/**
 * Line-by-line reader for `--output-format stream-json --verbose`.
 * Assistant `tool_use` blocks become activities; the `type:"result"` event is kept.
 */
export class StreamJsonReader {
  private buffer = "";
  result: unknown = undefined;
  toolCalls = 0;
  text = "";

  constructor(
    private readonly repoDir: string,
    private readonly onActivity?: (activity: Activity) => void,
  ) {}

  push(chunk: string) {
    this.text += chunk;
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      this.handleLine(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf("\n");
    }
  }

  end() {
    this.handleLine(this.buffer);
    this.buffer = "";
  }

  private handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: { type?: unknown; message?: { content?: unknown } };
    try {
      event = JSON.parse(trimmed);
    } catch {
      return; // Not an event line (e.g. a stray warning); ignore.
    }
    if (event.type === "result") {
      this.result = event;
      return;
    }
    if (event.type !== "assistant" || !Array.isArray(event.message?.content)) return;
    for (const block of event.message.content as Array<{ type?: unknown; name?: unknown; input?: unknown }>) {
      if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
      const input = (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>;
      const activity = activityFromToolUse(block.name, input, this.repoDir);
      if (!activity) continue;
      this.toolCalls++;
      this.onActivity?.(activity);
    }
  }
}

async function directoryExists(dir: string): Promise<boolean> {
  return (await fs.stat(dir).catch(() => null))?.isDirectory() ?? false;
}

export const runClaude: RunClaude = async (system, prompt, schema, options = {}) => {
  const { signal, timeoutMs = CLAUDE_TIMEOUT_MS, repoDir, onActivity } = options;
  const deep = repoDir !== undefined;
  const args = buildClaudeArgs(system, JSON.stringify(toCliJsonSchema(schema)), {
    deep,
    maxBudgetUsd: options.maxBudgetUsd ?? maxBudgetFromEnv(),
    model: process.env.PR_LENS_MODEL?.trim() || undefined,
  });

  // spawn reports a missing cwd as ENOENT too; check it so the error names the right thing.
  const cwd = repoDir ?? os.tmpdir();
  const missingCwd = () => new ClaudeError(`작업 폴더가 없습니다: ${cwd} (체크아웃이 정리되었을 수 있으니 다시 시도하세요)`);
  if (!(await directoryExists(cwd))) throw missingCwd();

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ClaudeError("요청이 취소되었습니다."));
      return;
    }

    // detached: the CLI gets its own process group, so aborts and timeouts can
    // kill it together with its children (e.g. ripgrep behind Grep).
    const child = spawn("claude", args, {
      cwd,
      env: childEnv(process.env) as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const pid = child.pid;
    if (pid !== undefined) trackGroup(pid);

    const stream = deep ? new StreamJsonReader(repoDir, onActivity) : null;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killReason: string | null = null;
    let killTimer: NodeJS.Timeout | undefined;

    const kill = (reason: string) => {
      if (killReason || pid === undefined) return;
      killReason = reason;
      killGroup(pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), 3000);
      killTimer.unref();
    };

    const timer = setTimeout(
      () => kill(`Claude 분석이 ${Math.round(timeoutMs / 60000)}분 안에 끝나지 않아 중단했습니다.`),
      timeoutMs,
    );
    const onAbort = () => kill("요청이 취소되었습니다.");
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (pid !== undefined) {
        registry.groups.delete(pid);
        if (killTimer) {
          // Never fire a delayed SIGKILL at a pgid that may be reused after the
          // group is gone. Members still alive now (the group cannot have been
          // reused while they exist) are part of the group we are killing.
          clearTimeout(killTimer);
          if (groupAlive(pid)) killGroup(pid, "SIGKILL");
        }
      }
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stream) stream.push(chunk);
      else stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    // The child may exit before reading all of stdin; the close handler reports why.
    child.stdin.on("error", () => {});

    let spawnFailed = false;
    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnFailed = true; // the close handler must not answer for a failed launch
      void (async () => {
        // The cwd could have been removed between the check above and spawn.
        const cwdGone = err.code === "ENOENT" && !(await directoryExists(cwd));
        finish(() =>
          reject(
            cwdGone
              ? missingCwd()
              : new ClaudeError(
                  err.code === "ENOENT"
                    ? "`claude` 명령을 찾을 수 없습니다. Claude Code CLI를 설치하고 로그인한 뒤, 서버를 실행한 셸의 PATH에 claude가 있는지 확인하세요."
                    : `Claude CLI를 실행하지 못했습니다: ${err.message}`,
                ),
          ),
        );
      })();
    });

    child.on("close", (code) => {
      if (spawnFailed) return;
      finish(() => {
        if (killReason) {
          reject(new ClaudeError(killReason));
          return;
        }
        try {
          if (stream) {
            stream.end();
            resolve(
              interpretClaudeResult(stream.result, stderr, code, schema, {
                toolCalls: stream.toolCalls,
                rawText: stream.text,
              }),
            );
          } else {
            resolve(parseClaudeOutput(stdout, stderr, code, schema));
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    child.stdin.end(prompt, "utf8");
  });
};
