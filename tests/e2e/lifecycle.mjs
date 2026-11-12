/**
 * E2E · 生命周期
 *
 * 用一个真实 DSH 宿主走完：未启用 → 启用 → 规划 → 改代码 → 自审 → 关闭。
 * 命令走 commands.execute()，工具走 tools.execute()，与 GUI 里点击同一条路径。
 */
import fs from "node:fs";
import path from "node:path";

import { StateStore } from "@autopilot-harness/core";

import {
  bootHost,
  cleanup,
  createChecker,
  makeProject,
  openSession,
  pluginSteers,
  say,
  sleep,
} from "./harness.mjs";

const pluginModule = await import("../../dist/plugin.js");
const api = await import("../../dist/index.js");

const { check, summary } = createChecker();

const projectA = makeProject("e2e-a");
const projectB = makeProject("e2e-b");

const host = await bootHost({ pluginModule });
const a1 = await openSession(host, "e2e-a1", projectA);
const a2 = await openSession(host, "e2e-a2", projectA);
const b1 = await openSession(host, "e2e-b1", projectB);

// ── 产物契约 ──────────────────────────────────────────────────────
check(
  "① 插件导出契约（name / apply）",
  pluginModule.name === "autopilot" && typeof pluginModule.apply === "function",
  `name=${pluginModule.name}`,
);
check(
  "② 适配层导出完整",
  Object.keys(api).length >= 15,
  `${Object.keys(api).length} 个导出`,
);

// ── 未启用：零侵入 ────────────────────────────────────────────────
await say(a1.handle, "你好呀");
await sleep(800);
check("③ 未启用项目不创建 .autopilot/", !fs.existsSync(path.join(projectA, ".autopilot")));
check("④ 未启用项目不创建 docs/", !fs.existsSync(path.join(projectA, "docs")));

// ── 显式启用 ──────────────────────────────────────────────────────
const enable = await host.commands.execute(
  a1.handle.agent,
  "/autopilot-enable",
  [],
  new AbortController().signal,
);
check(
  "⑤ /autopilot-enable 返回合法 CommandResult",
  enable?.result?.kind === "success",
  `${enable?.result?.kind}: ${(enable?.result?.text ?? "").split("\n")[0]}`,
);
check(
  "⑥ 启用后生成 config.yml 与 .autopilotignore",
  fs.existsSync(path.join(projectA, ".autopilot", "config.yml")) &&
    fs.existsSync(path.join(projectA, ".autopilotignore")),
);

const names = (host.commands.list?.() ?? [])
  .map((c) => c.name)
  .filter((n) => n.startsWith("autopilot-"));
check("⑦ 注册 6 个 /autopilot-* 命令", names.length === 6, names.sort().join(", "));

// ── 规划 ──────────────────────────────────────────────────────────
await host.commands.execute(
  a1.handle.agent,
  "/autopilot-on e2e-track 端到端测试",
  [],
  new AbortController().signal,
);
await a1.handle.agent.whenIdle();
await sleep(400);

const store = new StateStore(projectA);
check(
  "⑧ /autopilot-on → phase=planning",
  store.getSession(a1.conversationId)?.phase === "planning",
  String(store.getSession(a1.conversationId)?.phase),
);
check(
  "⑨ planning 阶段不武装自审（设计如此）",
  store.getSession(a1.conversationId)?.armed === 0,
  `armed=${store.getSession(a1.conversationId)?.armed}`,
);

// ── 真实工具调用 → tools/post-execute ─────────────────────────────
await say(a2.handle, "改个文件");
await sleep(300);

// 0.2.x 的 tools.execute 收的是「一批调用」，不是单条。
await host.tools.execute({
  calls: [
    {
      type: "tool-call",
      id: "call-1",
      name: "edit",
      arguments: JSON.stringify({
        file_path: path.join(projectA, "src", "feature.js"),
        content: "export const x = 1\n",
      }),
    },
  ],
  agent: a2.handle.agent,
  signal: new AbortController().signal,
});
await sleep(200);

check(
  "⑩ 真实工具编辑被 tools/post-execute 捕获并武装",
  store.getReviewChain(a2.conversationId)?.code_edited === 1,
  `code_edited=${store.getReviewChain(a2.conversationId)?.code_edited}`,
);

// ── 回合关闭 → 自动 steer 进入自审 ────────────────────────────────
const before = host.llm.steps;
await say(a2.handle, "继续");
await sleep(1200);

const injected = pluginSteers(a2.handle);
check(
  "⑪ 回合关闭时自动 steer，进入自审",
  injected.length >= 1 && host.llm.steps > before,
  `steer ${injected.length} 次，步骤 ${before}→${host.llm.steps}`,
);

// ── 关闭 ──────────────────────────────────────────────────────────
await host.commands.execute(
  a1.handle.agent,
  "/autopilot-off",
  [],
  new AbortController().signal,
);
await a1.handle.agent.whenIdle();
await sleep(300);

const off = store.getSession(a1.conversationId);
check(
  "⑫ /autopilot-off → 暂停且解除武装",
  off?.armed === 0 && off?.paused === 1,
  `armed=${off?.armed}, paused=${off?.paused}`,
);

// ── 多项目隔离 ────────────────────────────────────────────────────
await say(b1.handle, "我只是聊天");
await sleep(800);

check(
  "⑬ 另一项目（未启用）全程零文件",
  !fs.existsSync(path.join(projectB, ".autopilot")) &&
    !fs.existsSync(path.join(projectB, "docs")),
);
check("⑭ 未启用项目不产生任何 steer 注入", pluginSteers(b1.handle).length === 0);
check(
  "⑮ 已启用项目状态库独立存在",
  fs.existsSync(path.join(projectA, ".autopilot", "state.db")),
);

// ── 收尾 ──────────────────────────────────────────────────────────
store.close();
await a1.handle.dispose();
await a2.handle.dispose();
await b1.handle.dispose();
await host.dispose();
cleanup(projectA, projectB);

process.exit(summary() ? 0 : 1);