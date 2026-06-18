/**
 * Gated E2E for the pi-subagents <-> pi-c2c integration.
 *
 * Runs the real pi-subagents runner, real pi-c2c extension, real pi-mono
 * loader/session construction, and a real c2c binary against an isolated
 * local broker. It is intentionally opt-in because it crosses package
 * boundaries and shells out to c2c.
 *
 *   PI_C2C_SUBAGENTS_E2E=1 npm run test -- test/pi-c2c-subagent-e2e.test.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";

vi.setConfig({ testTimeout: 45_000 });

const E2E_ENABLED = process.env.PI_C2C_SUBAGENTS_E2E === "1";
const C2C_BIN = process.env.C2C_BIN ?? "c2c";
const REAL_PI_C2C_INDEX = resolve("../pi-c2c/src/index.ts");

function c2cAvailable(): boolean {
  try {
    execFileSync(C2C_BIN, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeE2E = E2E_ENABLED && c2cAvailable() && existsSync(REAL_PI_C2C_INDEX)
  ? describe
  : describe.skip;

interface FakePi {
  handlers: Map<string, Array<(event: any, ctx: any) => unknown | Promise<unknown>>>;
  messages: Array<{ message: any; options: any }>;
  tools: Map<string, any>;
  exec: (command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal; cwd?: string }) => Promise<{ stdout: string; stderr: string; code: number }>;
  on: (event: string, handler: (event: any, ctx: any) => unknown | Promise<unknown>) => void;
  registerTool: (tool: any) => void;
  registerCommand: () => void;
  registerMessageRenderer: () => void;
  sendMessage: (message: any, options?: any) => void;
}

function makeExec(brokerRoot: string, cwd: string): FakePi["exec"] {
  return (command, args, options) =>
    new Promise((resolveResult) => {
      const child = spawn(command, args, {
        cwd: options?.cwd ?? cwd,
        env: { ...process.env, C2C_MCP_BROKER_ROOT: brokerRoot },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("close", (code) => resolveResult({ stdout, stderr, code: code ?? 0 }));
      child.on("error", (err) => resolveResult({ stdout, stderr: String(err), code: 127 }));
    });
}

function makePi(brokerRoot: string, cwd: string): FakePi {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown | Promise<unknown>>>();
  const pi: FakePi = {
    handlers,
    messages: [],
    tools: new Map(),
    exec: makeExec(brokerRoot, cwd),
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) {
      pi.tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    sendMessage(message, options) {
      pi.messages.push({ message, options });
    },
  };
  return pi;
}

async function emit(pi: FakePi, event: string, payload: any, ctx: any): Promise<void> {
  for (const handler of pi.handlers.get(event) ?? []) {
    await handler(payload, ctx);
  }
}

function makeCtx(cwd: string, sessionId: string) {
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  return {
    cwd,
    ui: {
      theme,
      notify: vi.fn(),
      setStatus: vi.fn(),
      select: vi.fn(async () => "Close"),
      confirm: vi.fn(async () => false),
      input: vi.fn(async () => ""),
      custom: vi.fn(),
    },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    model: undefined,
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
}

function modelRegistryFor(model: any) {
  return {
    find: () => model,
    getAll: () => [model],
    getAvailable: () => [model],
    hasConfiguredAuth: () => true,
    isUsingOAuth: () => false,
    getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
    registerProvider: () => {},
    unregisterProvider: () => {},
  };
}

function registerE2eAgent(cfg: Partial<AgentConfig>): void {
  registerAgents(new Map([
    ["c2c-e2e", {
      name: "c2c-e2e",
      description: "c2c e2e",
      builtinToolNames: ["read"],
      extensions: true,
      skills: false,
      systemPrompt: "You are c2c e2e.",
      promptMode: "replace",
      inheritContext: false,
      isolated: false,
      ...cfg,
    } as AgentConfig],
  ]));
}

describeE2E("pi-c2c subagent integration E2E", () => {
  let root: string;
  let brokerRoot: string;
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;
  let previousEnv: Record<string, string | undefined>;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pi-c2c-subagents-e2e-"));
    brokerRoot = join(root, "broker");
    cwd = join(root, "work");
    mkdirSync(cwd, { recursive: true });

    previousEnv = {
      C2C_MCP_BROKER_ROOT: process.env.C2C_MCP_BROKER_ROOT,
      C2C_MCP_SESSION_ID: process.env.C2C_MCP_SESSION_ID,
      C2C_PI_ALIAS: process.env.C2C_PI_ALIAS,
      C2C_PI_RELAY: process.env.C2C_PI_RELAY,
      C2C_PI_CROSS_REPO: process.env.C2C_PI_CROSS_REPO,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      HOME: process.env.HOME,
    };
    process.env.C2C_MCP_BROKER_ROOT = brokerRoot;
    delete process.env.C2C_MCP_SESSION_ID;
    process.env.C2C_PI_ALIAS = "parent-e2e";
    process.env.C2C_PI_RELAY = "0";
    process.env.C2C_PI_CROSS_REPO = "0";
    process.env.PI_CODING_AGENT_DIR = join(root, "agent-dir");
    process.env.HOME = root;

    faux = registerFauxProvider({ provider: "faux-c2c-e2e", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });

  afterAll(() => {
    faux.unregister();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("registers a non-isolated subagent as a c2c peer and auto-exposes pi-c2c tools", async () => {
    const c2cExtension = (await import(REAL_PI_C2C_INDEX)).default;
    const parentPi = makePi(brokerRoot, cwd);
    const parentCtx = makeCtx(cwd, "parent-session");
    c2cExtension(parentPi as any);
    await emit(parentPi, "session_start", { type: "session_start" }, parentCtx);

    registerE2eAgent({
      extensions: [REAL_PI_C2C_INDEX],
      extSelectors: ["ext:not-pi-c2c/nope"],
    });

    const model = faux.getModel();
    const childPi = makePi(brokerRoot, cwd);
    const ctx: any = {
      ...makeCtx(cwd, "parent-for-runner"),
      getSystemPrompt: () => "PARENT",
      model,
      modelRegistry: modelRegistryFor(model),
    };

    let activeTools: string[] = [];
    let effectivePrompt = "";
    let childSession: any;
    try {
      await runAgent(ctx, "c2c-e2e", "go", {
        pi: childPi as any,
        model,
        agentId: "Plan#abc123",
        onSessionCreated: (session) => {
          childSession = session;
          activeTools = session.getActiveToolNames();
        },
      });
    } catch {
      // The faux model turn is not the assertion target; session construction
      // and extension session_start have already run.
    } finally {
      effectivePrompt = childSession?.systemPrompt ?? "";
      await childSession?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      childSession?.dispose?.();
      await emit(parentPi, "session_shutdown", { type: "session_shutdown", reason: "quit" }, parentCtx);
    }

    expect(activeTools).toContain("c2c_pi_whoami");
    expect(activeTools).toContain("c2c_pi_send");

    const notice = parentPi.messages.find((m) =>
      typeof m.message?.content === "string"
      && m.message.content.includes("Subagent Plan#abc123 registered as"),
    );
    expect(notice?.message.content).toMatch(/registered as `parent-e2e-a[0-9a-f]{6}`/);
    const childAlias = notice?.message.content.match(/`([^`]+)`/)?.[1];
    expect(childAlias).toMatch(/^parent-e2e-a[0-9a-f]{6}$/);
    expect(effectivePrompt).toContain(`Your c2c alias is \`${childAlias}\`.`);
    expect(effectivePrompt).toContain("Your parent c2c alias is `parent-e2e`.");
    expect(effectivePrompt).toContain('c2c_pi_send(target="parent-e2e", body="<message>")');

    const list = JSON.parse(execFileSync(C2C_BIN, ["list", "--json"], {
      env: { ...process.env, C2C_MCP_BROKER_ROOT: brokerRoot, C2C_MCP_SESSION_ID: "parent-session" },
      encoding: "utf8",
    }));
    const aliases = list.map((peer: { alias: string }) => peer.alias);
    expect(aliases).toContain("parent-e2e");
    expect(aliases.some((alias: string) => /^parent-e2e-a[0-9a-f]{6}$/.test(alias))).toBe(true);
  });

  it("still suppresses pi-c2c tools for isolated agents", async () => {
    registerE2eAgent({
      extensions: [REAL_PI_C2C_INDEX],
      isolated: true,
    });
    const model = faux.getModel();
    const ctx: any = {
      ...makeCtx(cwd, "isolated-runner"),
      getSystemPrompt: () => "PARENT",
      model,
      modelRegistry: modelRegistryFor(model),
    };

    let activeTools: string[] = [];
    let childSession: any;
    try {
      await runAgent(ctx, "c2c-e2e", "go", {
        pi: makePi(brokerRoot, cwd) as any,
        model,
        isolated: true,
        agentId: "Isolated#abc123",
        onSessionCreated: (session) => {
          childSession = session;
          activeTools = session.getActiveToolNames();
        },
      });
    } catch {
      // See previous test: the active tools are captured before prompt work.
    } finally {
      await childSession?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      childSession?.dispose?.();
    }

    expect(activeTools).not.toContain("c2c_pi_whoami");
    expect(activeTools).not.toContain("c2c_pi_send");
  });
});
