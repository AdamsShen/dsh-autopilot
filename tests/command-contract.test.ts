/**
 * 命令契约测试。
 *
 * 背景：DSH 的 `CommandDefinition.handler` 必须返回
 * `{ kind: "success" | "error", text? }`，返回裸字符串会触发
 * `command "<name>" handler must return a CommandResult`。
 * 这个错误只在 GUI 实际执行命令时暴露，单测里很容易漏掉，
 * 所以这里用最小的假 ctx 拉起插件、取出注册的 handler 直接断言形状。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { apply } from "../src/plugin.js";

function tmpProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-dsh-cmd-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"t"}\n');
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return root;
}

/** 捕获插件注册的命令定义。 */
function captureCommands(projectRoot: string) {
  const registered: Array<{
    name: string;
    description: string;
    handler: (inv: unknown) => unknown;
  }> = [];

  const commandsService = {
    register: (cmd: (typeof registered)[number]) => {
      registered.push(cmd);
      return () => {};
    },
    get: (name: string) => (name === "commands" ? commandsService : undefined),
  };

  const ctx = {
    on: () => {},
    effect: (fn: () => unknown) => {
      try {
        fn();
      } catch {
        /* ignore */
      }
    },
    inject: (deps: string[], fn: (s: unknown) => void) => {
      if (deps.includes("commands")) {
        fn({ get: (n: string) => (n === "commands" ? commandsService : undefined) });
      }
    },
    logger: { info: () => {}, debug: () => {}, warn: () => {} },
  };

  apply(ctx as never, { projectRoot, autoInit: false });
  return registered;
}

describe("dsh 命令契约（CommandResult）", () => {
  it("注册全部 6 个命令", () => {
    const cmds = captureCommands(tmpProject());
    expect(cmds.map((c) => c.name).sort()).toEqual([
      "autopilot-enable",
      "autopilot-off",
      "autopilot-on",
      "autopilot-replan",
      "autopilot-resume",
      "autopilot-run",
    ]);
  });

  it("每个 handler 都返回对象而不是裸字符串（回归锁定）", async () => {
    const root = tmpProject();
    const cmds = captureCommands(root);
    for (const cmd of cmds) {
      const out = (await cmd.handler({
        agent: { id: "s1", session: { id: "s1", header: { cwd: root } } },
        rawInput: "",
        signal: new AbortController().signal,
        commandId: "c1",
      })) as { kind?: unknown; text?: unknown };
      expect(
        typeof out,
        `${cmd.name} 必须返回对象（DSH 的 CommandResult），不能是裸字符串`,
      ).toBe("object");
      expect(["success", "error"]).toContain(out?.kind);
    }
  });

  it("无项目目录时返回 error 而非抛异常", async () => {
    const cmds = captureCommands(tmpProject());
    const enable = cmds.find((c) => c.name === "autopilot-enable")!;
    const out = (await enable.handler({
      agent: { id: "s1", session: { id: "s1" } },
      rawInput: "",
      signal: new AbortController().signal,
      commandId: "c1",
    })) as { kind: string; text?: string };
    expect(out.kind).toBe("error");
    expect(out.text).toBeTruthy();
  });

  it("命令回环消息必须自带唯一 id（防会话损坏回归）", async () => {
    // 背景：`/autopilot-*` 用 followup 把文本投回对话。DSH 落盘 user/message
    // 时不补 id，重开会话时持久化层校验 id 缺失即抛
    // `lacks an identified message`，整个会话打不开。
    const root = tmpProject();
    fs.mkdirSync(path.join(root, ".autopilot"), { recursive: true });
    fs.writeFileSync(path.join(root, ".autopilot", "config.yml"), "platforms: []\n");

    const cmds = captureCommands(root);
    const on = cmds.find((c) => c.name === "autopilot-on")!;
    const sent: Array<{ id?: unknown; role?: unknown }> = [];

    const out = (await on.handler({
      agent: {
        id: "s1",
        session: { id: "s1", header: { cwd: root } },
        followup: (message: unknown) => sent.push(message as { id?: unknown }),
      },
      rawInput: "",
      signal: new AbortController().signal,
      commandId: "c1",
    })) as { kind: string };

    expect(out.kind).toBe("success");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.role).toBe("user");
    expect(typeof sent[0]?.id).toBe("string");
    expect(sent[0]?.id).not.toBe("");
  });

  it("已启用的项目返回 success 且说明已启用", async () => {
    const root = tmpProject();
    fs.mkdirSync(path.join(root, ".autopilot"), { recursive: true });
    fs.writeFileSync(path.join(root, ".autopilot", "config.yml"), "platforms: []\n");

    const cmds = captureCommands(root);
    const enable = cmds.find((c) => c.name === "autopilot-enable")!;
    const out = (await enable.handler({
      agent: { id: "s1", session: { id: "s1", header: { cwd: root } } },
      rawInput: "",
      signal: new AbortController().signal,
      commandId: "c1",
    })) as { kind: string; text?: string };
    expect(out.kind).toBe("success");
    expect(out.text).toContain("已启用");
  });
});
