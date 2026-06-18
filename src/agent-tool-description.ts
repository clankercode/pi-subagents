import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAvailableTypes } from "./agent-types.js";
import type { ToolDescriptionMode } from "./settings.js";
import type { AgentConfig } from "./types.js";
import { MAX_RECURSIVE_DEPTH } from "./types.js";

const formatToolsSuffix = (cfg: AgentConfig | undefined): string => {
  const tools = cfg?.builtinToolNames;
  if (!tools || tools.length === 0) return "*";
  const isFullSet =
    tools.length === BUILTIN_TOOL_NAMES.length
    && BUILTIN_TOOL_NAMES.every((t) => tools.includes(t));
  return isFullSet ? "*" : tools.join(", ");
};

export function getModelLabelFromConfig(model: string): string {
  const name = model.includes("/") ? model.split("/").pop()! : model;
  return name.replace(/-\d{8}$/, "");
}

const buildTypeListText = () => {
  const available = getAvailableTypes();

  return available.map((name) => {
    const cfg = getAgentConfig(name);
    const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
    const toolsSuffix = ` (Tools: ${formatToolsSuffix(cfg)})`;
    return `- ${name}: ${cfg?.description ?? name}${modelSuffix}${toolsSuffix}`;
  }).join("\n");
};

const firstSentence = (text: string): string => {
  const match = text.match(/^.*?[.!?](?=\s|$)/s);
  return (match ? match[0] : text).replace(/\s+/g, " ").trim();
};

const buildCompactTypeListText = () =>
  getAvailableTypes().map((name) => {
    const cfg = getAgentConfig(name);
    return `- ${name}: ${firstSentence(cfg?.description ?? name)} (Tools: ${formatToolsSuffix(cfg)})`;
  }).join("\n");

export interface AgentToolDescriptionOptions {
  mode: ToolDescriptionMode;
  extensionDepth: number;
  schedulingEnabled: boolean;
}

export function buildScheduleGuideline(schedulingEnabled: boolean): string {
  return schedulingEnabled
    ? `\n- Use \`schedule\` only when the user explicitly asked for scheduled / recurring / delayed execution (e.g. "every Monday", "in an hour"). Don't auto-schedule from vague intent like "monitor X" — run once now or ask.`
    : "";
}

export function buildAgentToolDescription(options: AgentToolDescriptionOptions): string {
  const scheduleGuideline = buildScheduleGuideline(options.schedulingEnabled);
  const recursiveGuideline = `Recursive agents are allowed through depth ${MAX_RECURSIVE_DEPTH}. Current recursive depth: ${options.extensionDepth}/${MAX_RECURSIVE_DEPTH}.`;

  const compactAgentToolDescription = `Launch an autonomous agent for complex, multi-step tasks. Agent types:
${buildCompactTypeListText()}

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.
- Parallel work: one message, multiple Agent calls; they all run in the background. You are notified when agents finish — never poll or sleep.
- Background by default: when you have useful independent work, launch it and continue. Doing nothing while an agent runs is worse than letting background work proceed.
- Recursive agents: current depth ${options.extensionDepth}/${MAX_RECURSIVE_DEPTH}; you may spawn subagents until depth ${MAX_RECURSIVE_DEPTH}.
- The result is not shown to the user — summarize it for them. Verify an agent's claimed code changes before reporting work done.
- resume continues a previous agent by ID; steer_subagent messages a running one.
- isolation: "worktree" runs the agent in an isolated git worktree; changes land on a branch.`;

  const fullAgentToolDescription = `Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently. If the user specifies that they want agents run "in parallel", you MUST send a single message with multiple tool calls.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting work as done.
- Agents always run in the background. You will be notified when each completes — do NOT poll or sleep waiting for it. Continue with other work or respond to the user instead.
- Background by default: when useful independent work exists, launch it and keep going. Doing nothing while an agent runs is worse than using background capacity.
- ${recursiveGuideline}
- Use get_subagent_result if you need to retrieve a result before the completion notification arrives, but do not poll or sleep waiting for it.
- Use resume with an agent ID to continue a previous agent's work. A new (non-resume) Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.
- Use isolation: "worktree" to run the agent in an isolated git worktree (safe parallel file modifications). The worktree is automatically cleaned up if the agent makes no changes; otherwise the path and branch are returned in the result.${scheduleGuideline}

## Writing the prompt

Provide clear, detailed prompts so the agent can work autonomously. Brief it like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.`;

  const renderToolDescriptionTemplate = (template: string): string => {
    const vars: Record<string, () => string> = {
      typeList: buildTypeListText,
      compactTypeList: buildCompactTypeListText,
      agentDir: getAgentDir,
      scheduleGuideline: () => scheduleGuideline,
      currentDepth: () => String(options.extensionDepth),
      maxDepth: () => String(MAX_RECURSIVE_DEPTH),
      recursiveGuideline: () => recursiveGuideline,
    };
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      if (vars[name]) return vars[name]();
      console.warn(`[pi-subagents] agent-tool-description.md: unknown placeholder ${raw} left as-is`);
      return raw;
    });
  };

  const loadCustomToolDescription = (): string | undefined => {
    for (const path of [
      join(process.cwd(), ".pi", "agent-tool-description.md"),
      join(getAgentDir(), "agent-tool-description.md"),
    ]) {
      try {
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf-8").trim();
        if (text) return renderToolDescriptionTemplate(text);
        console.warn(`[pi-subagents] ${path} is empty — ignoring`);
      } catch (err) {
        console.warn(`[pi-subagents] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return undefined;
  };

  if (options.mode === "compact") return compactAgentToolDescription;
  if (options.mode === "custom") {
    const custom = loadCustomToolDescription();
    if (custom) return custom;
    console.warn('[pi-subagents] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"');
  }
  return fullAgentToolDescription;
}
