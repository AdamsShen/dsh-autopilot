/**
 * E2E 公共设施。
 *
 * 这一层刻意只做三件事：造项目目录、起一个真实 DSH 宿主、收集断言结果。
 * 具体场景写在 lifecycle.mjs / safety.mjs 里，避免"测试框架"本身膨胀。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { SessionStore, SessionId } from "@deepseek-ai/dsh-session";
import { LlmRuntime, LlmAdapter } from "@deepseek-ai/dsh-llm";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import Commands from "@deepseek-ai/dsh-commands";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import * as nativeExecutor from "@deepseek-ai/dsh-tool-executor-native";
import {
  DSH_PLUGIN_SOURCE,
  DSH_PLUGIN_SOURCE_KIND,
} from "../../dist/index.js";

export const PROVIDER = "e2e";

/** 断言收集器。失败不抛异常，方便一次跑完所有项再汇总。 */
export function createChecker() {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok });
    console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  };
  const summary = () => {
    const pass = results.filter((r) => r.ok).length;
    console.log("\n" + "=".repeat(46));
    console.log(`通过 ${pass}/${results.length}`);
    if (pass !== results.length) {
      console.log("失败项：");
      for (const r of results) if (!r.ok) console.log("  ✗", r.name);
    }
    return pass === results.length;
  };
  return { check, summary, results };
}

/**
 * 造一个"看起来像项目"的临时目录。
 * 必须有 package.json 与 .git：初始化时的安全护栏要求目录像项目才肯动手。
 */
export function makeProject(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"e2e-demo"}');
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

/** 固定返回文本的假模型；每次调用计一步，用来证明"真的又跑了一步"。 */
export class ScriptedLlm extends LlmAdapter {
  constructor() {
    super();
    this.steps = 0;
  }
  providerInfo(provider) {
    return { id: provider, name: "scripted", models: [] };
  }
  providerRetryPolicy() {
    return undefined;
  }
  async listModels() {
    return [];
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model };
  }
  async *stream() {
    this.steps += 1;
    const text = `step-${this.steps}`;
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: "end-turn" };
  }
}

/**
 * 起一个真实 DSH 宿主并装上本插件。
 *
 * 注意插件从 `dist/` 加载（跑前需 build），而不是源码：这样测的是**实际发布产物**，
 * 能抓到 tsc 输出、exports 映射一类只在打包后才暴露的问题。
 */
export async function bootHost({ pluginDist, pluginModule, tools = true } = {}) {
  const ctx = new Context();
  // 注册顺序即依赖顺序：AgentRegistry 需要 sessionProjections，
  // ToolRuntime 需要 systemPrompt，AgentLoop 需要它们全部就位。
  ctx.plugin(SessionStore);
  ctx.plugin(SessionProjectionRegistry);
  ctx.plugin(LlmRuntime);
  ctx.plugin(SystemPrompt);
  ctx.plugin(ToolRuntime);
  // 0.2.x 起工具不再由 ToolRuntime 直接执行，必须挂一个执行器插件。
  ctx.plugin(nativeExecutor);
  ctx.plugin(AgentRegistry);
  ctx.plugin(Commands);
  ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 4 });
  ctx.plugin({ name: pluginModule.name, apply: (c) => pluginModule.apply(c, {}) });

  await new Promise((r) => setTimeout(r, 200));

  const llm = new ScriptedLlm();
  ctx.get("llm").registerAdapter([PROVIDER], llm);

  const toolsRuntime = ctx.get("tools");
  let unregister = () => {};

  if (tools) {
    // 注册一个真实编辑工具：只有经 tools.execute() 走完整管道，
    // tools/post-execute 才会自然触发，而不是被测试手工调用。
    unregister = toolsRuntime.register({
      name: "edit",
      description: "write a file",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          content: { type: "string" },
        },
        required: ["file_path"],
      },
      output: {
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
        render: () => [{ type: "text", text: "ok" }],
      },
      execute: async (args) => {
        fs.mkdirSync(path.dirname(args.file_path), { recursive: true });
        fs.writeFileSync(args.file_path, args.content ?? "export const x = 1\n");
        return { ok: true };
      },
    });
  }

  return {
    ctx,
    llm,
    agents: ctx.get("agents"),
    commands: ctx.get("commands"),
    tools: toolsRuntime,
    dispose: async () => {
      unregister();
    },
  };
}

/** 建一个会话并返回句柄与 conversationId。 */
export async function openSession(host, sessionId, cwd) {
  const handle = await host.agents.create({
    sessionId: SessionId(sessionId),
    meta: { cwd },
    agentOptions: { provider: PROVIDER, model: "m" },
  });

  // 拦截 steer：这是"插件要求循环继续跑一步"的唯一出口。
  // 直接看会话事件在不同 DSH 版本里形态不一（events / eventsSnapshot），
  // 而 steer 是 Agent 的公开方法，跨版本稳定。
  const steers = [];
  const original = handle.agent.steer.bind(handle.agent);
  handle.agent.steer = (message) => {
    steers.push(message);
    return original(message);
  };
  handle.steers = steers;

  return { handle, conversationId: String(handle.agent.id) };
}

/** 发一条用户消息并等回合结束。 */
export async function say(handle, text) {
  handle.agent.followup({
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
  await handle.agent.whenIdle();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 取插件发起的 steer 调用。
 * 只统计本插件发的，避免把别的来源也算进来。
 *
 * 判据随 DSH session 格式 v4 变化：
 *   v4 起插件注入消息的 source 不再带 `plugin` 字段，而是把生产者身份
 *   编进 kind（`plugin:<生产者名>`）。仍兼容 v3 时代的
 *   `{ kind: "plugin", plugin: "<生产者名>" }` 写法。
 *
 * 判据直接引用插件导出的常量，不再手写字面量：
 *   否则常量改名时这里会静默失配，测试仍绿但断言失效
 *   （本次缺陷正是「测试把错误写法当成规范」才长期未被发现）。
 */
export function pluginSteers(handle) {
  return (handle?.steers ?? []).filter((m) => {
    const source = m?.source;
    if (!source || typeof source !== "object") return false;
    if (source.kind === DSH_PLUGIN_SOURCE_KIND) return true;
    return source.kind === "plugin" && source.plugin === DSH_PLUGIN_SOURCE;
  });
}

/** 清理临时项目目录。 */
export function cleanup(...roots) {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}