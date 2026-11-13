/**
 * E2E · 计划 → 执行 → 自审闭环（验证 hook 是否真的把活自动跑完）
 *
 * 场景与"用户只发一条消息"的约束：
 *   1. /autopilot-enable 启用项目
 *   2. /autopilot-on <slug> <brief> 进入 planning
 *   3. 落地真实产物（plan.md + checklist.md，含未勾选项）
 *   4. /autopilot-run 进入 executing
 *   5. 用户只发一条「开始执行」
 *   6. 之后的每一步都由 hook 驱动：
 *      模型改代码 → tools/post-execute 武装 → turn-stopping 自动 steer 自审
 *      → 模型修复 → 确认轮 → 耗尽后自动停下，全程不再需要用户输入。
 *
 * 断言的重点不是文案，而是"没有 hook 就不会发生的自动化"：
 *   - 单条用户消息后出现多次 steer（每次 steer = 宿主为插件多跑一步）
 *   - 模型自己的改动确实被 tools/post-execute 捕获
 *   - steer 消息都带唯一 id（缺 id 会让会话在重开时被判损坏）
 *   - 确认轮耗尽后自动停止（不无限循环）
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
} from "./harness.mjs";

const pluginModule = await import("../../dist/plugin.js");
const { check, summary } = createChecker();

const project = makeProject("e2e-plan");
const featurePath = path.join(project, "src", "feature.js");

/**
 * 脚本化的"模型行为"：这就是一个配合的编码代理在清单里的动作序列。
 * 第 1 步做计划中的活，第 3 步做自审要求的修复，其余为纯文本（确认轮）。
 */
const script = [
  { toolCall: { name: "edit", arguments: { file_path: featurePath, content: "export const answer = 42\n" } } },
  { text: "task-1 已实现" },
  { toolCall: { name: "edit", arguments: { file_path: featurePath, content: "export const answer = 42\nexport const fixed = true\n" } } },
  { text: "已按审查意见修复" },
];

const host = await bootHost({ pluginModule, script });
const { handle, conversationId } = await openSession(host, "e2e-plan1", project);
const signal = () => new AbortController().signal;

// ── 启用 + 进入 planning ───────────────────────────────────────────
const enable = await host.commands.execute(
  handle.agent,
  "/autopilot-enable",
  [],
  signal(),
);
check("① 启用项目", enable?.result?.kind === "success", enable?.result?.kind);

await host.commands.execute(
  handle.agent,
  "/autopilot-on e2e-track 端到端自动化验证",
  [],
  signal(),
);
await handle.agent.whenIdle();

const store = new StateStore(project);
check(
  "② /autopilot-on 后处于 planning",
  store.getSession(conversationId)?.phase === "planning",
  String(store.getSession(conversationId)?.phase),
);

// ── 落地真实产物（规划阶段的产物由规划者产出）────────────────────
const plansDir = path.join(project, "docs", "autopilot", "plans", "e2e-track");
fs.mkdirSync(plansDir, { recursive: true });
fs.writeFileSync(path.join(plansDir, "plan.md"), "# e2e-track\n\n端到端自动化验证。\n");
fs.writeFileSync(
  path.join(plansDir, "checklist.md"),
  "# e2e-track\n\n- [ ] task-1 — 修改 feature.js\n",
);
check("③ 生成 plan.md + checklist.md", fs.existsSync(path.join(plansDir, "checklist.md")));

// ── 进入 executing ────────────────────────────────────────────────
await host.commands.execute(handle.agent, "/autopilot-run", [], signal());
await handle.agent.whenIdle();

const running = store.getSession(conversationId);
check(
  "④ /autopilot-run 进入 executing 并绑定 checklist",
  running?.phase === "executing" &&
    String(running?.checklist_path ?? "").endsWith("checklist.md"),
  `phase=${running?.phase}, checklist=${path.basename(String(running?.checklist_path ?? ""))}`,
);

// ── 只发这一条用户消息，后面全交给 hook ──────────────────────────
const stepsBefore = host.llm.steps;
const steersBefore = pluginSteers(handle).length;
await say(handle, "开始执行");

const steers = pluginSteers(handle).slice(steersBefore);
const steps = host.llm.steps - stepsBefore;

// 脚本模型只改代码、不写完成证据（verify-last.json），因此预期链路会：
// 先要求证据 → 连续多轮后触发 stuck 保护。这证明 nudge/保护逻辑真的在 hook 里跑。
const steerTexts = steers.map((m) => String(m?.content?.[0]?.text ?? ""));
check(
  "⑤ 自动 steer 里出现「补证据」要求",
  steerTexts.some((t) => t.includes("Need evidence")),
  steerTexts.find((t) => t.includes("Need evidence"))?.slice(0, 60) ?? "未出现",
);
check(
  "⑤b 多轮无进展后触发 stuck 保护",
  steerTexts.some((t) => t.startsWith("Stuck:")),
  steerTexts.find((t) => t.startsWith("Stuck:"))?.slice(0, 50) ?? "未出现",
);
check(
  "⑥ 单条用户消息后自动连续 steer（≥3 次）",
  steers.length >= 3,
  `steer ${steers.length} 次`,
);
check(
  "⑦ 每次 steer 都真的多跑了一步",
  steps >= 1 + steers.length,
  `模型步数 ${steps}，steer ${steers.length}`,
);
check(
  "⑧ 自动 steer 的消息都带唯一 id",
  steers.every((m) => typeof m?.id === "string" && m.id.length > 0) &&
    new Set(steers.map((m) => m.id)).size === steers.length,
  steers.map((m) => String(m?.id).slice(0, 8)).join(","),
);
check(
  "⑨ steer 消息来自插件（source.kind=plugin:autopilot）",
  steers.every((m) => m?.source?.kind === "plugin:autopilot"),
  [...new Set(steers.map((m) => m?.source?.kind))].join(","),
);
check(
  "⑩ 自动链路真的改了文件（计划中的活被做完）",
  fs.existsSync(featurePath) && fs.readFileSync(featurePath, "utf8").includes("fixed"),
  fs.existsSync(featurePath) ? fs.readFileSync(featurePath, "utf8").trim().split("\n").length + " 行" : "文件不存在",
);
check(
  "⑪ 自动链路自然停下（steer 数有上限，不无限循环）",
  steers.length <= 20,
  `steer ${steers.length} 次`,
);
check(
  "⑫ 结束后没有残留循环（agent 空闲）",
  handle.agent.status === undefined || handle.agent.status === "idle",
  `status=${handle.agent.status}`,
);

// ── 收尾 ──────────────────────────────────────────────────────────
store.close();
await handle.dispose();
await host.dispose();
cleanup(project);

process.exit(summary() ? 0 : 1);
