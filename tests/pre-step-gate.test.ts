/**
 * pre-step 门禁语义测试。
 *
 * 背景（历史缺陷，两处都踩过）：
 *   1) 早先用 `agent.inject()` 回灌「Rejected this prompt」通知，但宿主文档明确
 *      inject 只对**下一个** pre-step 生效 —— 当前步的 batch 已经认领完毕。
 *      结果通知晚一步才进模型视野。
 *   2) inject 只是旁白，原始 prompt 仍然进入模型，文案里的 "Rejected" 名不副实
 *      （用户敲 /autopilot-run 但无计划时，模型照样会去「执行」这条命令）。
 *
 * 现在的契约：门禁拒绝时**替换**该 batch 的消息，原始 prompt 丢弃、通知在
 * 当前步立刻可见，且不再产生任何 inject。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { apply } from "../src/plugin.js";

type Handler = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;

/** 建一个已启用 Autopilot 的项目（存在 .autopilot/config.yml 才算启用）。 */
function enabledProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-dsh-gate-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"t"}\n');
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, ".autopilot"), { recursive: true });
  fs.writeFileSync(path.join(root, ".autopilot", "config.yml"), "platforms: []\n");
  return root;
}

/** 拉起插件并取回 pre-step 监听器。 */
function capturePreStep(root: string): {
  handler: Handler;
  injected: unknown[];
} {
  const handlers = new Map<string, Handler>();
  const injected: unknown[] = [];
  const ctx = {
    on: (name: string, fn: Handler) => {
      handlers.set(name, fn);
      return () => {};
    },
    inject: () => {},
    logger: { info: () => {}, debug: () => {}, warn: () => {} },
  };
  apply(ctx as never, { projectRoot: root, autoInit: false });
  const handler = handlers.get("agent/pre-step");
  if (!handler) throw new Error("插件没有注册 agent/pre-step");
  return { handler, injected };
}

function userMessage(text: string, id = "u-1"): Record<string, unknown> {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function payloadFor(root: string): Record<string, unknown> {
  return {
    agent: { id: "s1", session: { id: "s1", header: { cwd: root } } },
    turn: 1,
    step: 1,
  };
}

describe("pre-step 门禁：拒绝即替换", () => {
  it("门禁拒绝时丢弃原 prompt，把通知放进当前 batch", async () => {
    const root = enabledProject();
    const { handler } = capturePreStep(root);
    const original = userMessage("/autopilot-run");
    const runtimeCtx = {
      id: "ctx-1",
      role: "user",
      content: [{ type: "text", text: "runtime context" }],
      source: { kind: "runtime-context" },
    };

    const out = (await handler(payloadFor(root), async () => ({
      kind: "enter",
      messages: [original, runtimeCtx],
    }))) as { kind: string; messages: Array<Record<string, unknown>> };

    expect(out.kind).toBe("enter");
    // runtime-context 必须原样保留（它不是 autopilot 的输入）
    expect(out.messages.some((m) => m.id === "ctx-1")).toBe(true);
    // 原始命令不得进入模型
    const texts = out.messages.map(
      (m) => (m.content as Array<{ text?: string }>)[0]?.text ?? "",
    );
    expect(texts).not.toContain("/autopilot-run");
    // 通知必须在**当前** batch 里，且带 id（否则落盘会判会话损坏）
    const notice = out.messages.find((m) => m.id !== "ctx-1" && m.id !== "u-1");
    expect(notice).toBeDefined();
    expect(String(texts.at(-1))).toContain("No runnable plan");
    expect((notice?.source as { kind?: string })?.kind).toBe("plugin:autopilot");
    expect(typeof notice?.id).toBe("string");
  });

  it("普通聊天不改变 batch（不误伤、不注入）", async () => {
    const root = enabledProject();
    const { handler } = capturePreStep(root);
    const original = userMessage("帮我看看这个报错");

    const out = (await handler(payloadFor(root), async () => ({
      kind: "enter",
      messages: [original],
    }))) as { kind: string; messages: Array<Record<string, unknown>> };

    expect(out.kind).toBe("enter");
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toBe(original);
  });

  it("上游已 reject 时原样透传，不改写成 enter", async () => {
    const root = enabledProject();
    const { handler } = capturePreStep(root);
    const rejection = { kind: "reject" };

    const out = await handler(payloadFor(root), async () => rejection);
    expect(out).toBe(rejection);
  });
});
