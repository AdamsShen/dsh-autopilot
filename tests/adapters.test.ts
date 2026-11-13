import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewEngine, StateStore } from "@autopilot-harness/core";
import { buildPluginMessage } from "../src/plugin.js";
import {
  buildNeedPickMessage,
  conversationIdFromDshPayload,
  DSH_EDIT_TOOLS,
  DSH_PLATFORM,
  DSH_PLUGIN_SOURCE,
  DSH_PLUGIN_SOURCE_KIND,
  DSH_STOP_CAP_RAISE_FOUND,
  filePathsFromDshToolInput,
  handleDshSubmit,
  handleDshToolResult,
  handleDshTurnStopping,
  isDshEditTool,
  isDshHarnessMessage,
  resolveDshWorkspaceRoot,
} from "../src/index.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ap-dsh-port-"));
}

/** 真实 ReviewEngine —— 绝不省略 config（fail-open 会掩盖 settle bug）。 */
function testEngine(store: StateStore, projectRoot: string): ReviewEngine {
  return new ReviewEngine(store, {
    confirmRounds: 5,
    reviewScope: "executing_only",
    verifyEnabled: false,
    verifyCommands: [],
    maxIdleStops: 5,
    maxErrorsBeforePause: 3,
    projectRoot,
    recoverDebounceMs: 0,
  });
}

function initProject(root: string): void {
  fs.mkdirSync(path.join(root, ".autopilot"), { recursive: true });
}

describe("dsh-autopilot 常量与纯函数", () => {
  it("暴露锁定的常量", () => {
    expect(DSH_PLATFORM).toBe("dsh");
    expect(DSH_PLUGIN_SOURCE).toBe("autopilot");
    // DSH 无已知 stop 硬上限 → 不降级
    expect(DSH_STOP_CAP_RAISE_FOUND).toBe(false);
    expect([...DSH_EDIT_TOOLS]).toEqual([
      "write",
      "edit",
      "apply_patch",
      "notebook_edit",
    ]);
  });

  it("识别编辑工具（锚定精确名，不做子串匹配）", () => {
    expect(isDshEditTool("write")).toBe(true);
    expect(isDshEditTool("edit")).toBe(true);
    expect(isDshEditTool("apply_patch")).toBe(true);
    expect(isDshEditTool("notebook_edit")).toBe(true);
    // 子串不算
    expect(isDshEditTool("editor")).toBe(false);
    expect(isDshEditTool("write_file")).toBe(false);
    expect(isDshEditTool("bash")).toBe(false);
    expect(isDshEditTool(null)).toBe(false);
    expect(isDshEditTool(42)).toBe(false);
  });

  it("解析 conversationId（agent.id === session.id）", () => {
    expect(conversationIdFromDshPayload({ conversationId: "abc" })).toBe("abc");
    expect(conversationIdFromDshPayload({ conversationId: "  abc  " })).toBe(
      "abc",
    );
    expect(conversationIdFromDshPayload({ conversationId: "" })).toBe("");
    expect(conversationIdFromDshPayload({ conversationId: null })).toBe("");
    expect(conversationIdFromDshPayload({})).toBe("");
    // 控制字符拒绝
    expect(conversationIdFromDshPayload({ conversationId: "a\u0000b" })).toBe(
      "",
    );
    // 超长拒绝
    expect(
      conversationIdFromDshPayload({ conversationId: "x".repeat(300) }),
    ).toBe("");
  });

  it("解析工作区根：会话 cwd 优先于进程 cwd（全局插件必须按项目隔离）", () => {
    // 会话 cwd 是正确来源，必须最高优先
    expect(
      resolveDshWorkspaceRoot({
        sessionCwd: "/proj/a",
        configuredRoot: "/pinned",
        fallbackCwd: "/process-cwd",
      }),
    ).toBe("/proj/a");
    // 会话没有 cwd 时，显式配置兜底
    expect(
      resolveDshWorkspaceRoot({
        configuredRoot: "/pinned",
        fallbackCwd: "/process-cwd",
      }),
    ).toBe("/pinned");
    // 都没有才用进程 cwd（尽量不该发生）
    expect(resolveDshWorkspaceRoot({ fallbackCwd: "/process-cwd" })).toBe(
      "/process-cwd",
    );
    expect(resolveDshWorkspaceRoot({})).toBeNull();
    expect(resolveDshWorkspaceRoot({ sessionCwd: "  " })).toBeNull();
  });

  it("不同会话 cwd 解析出不同项目根（多项目隔离的前提）", () => {
    const a = resolveDshWorkspaceRoot({ sessionCwd: "/repos/alpha" });
    const b = resolveDshWorkspaceRoot({ sessionCwd: "/repos/beta" });
    expect(a).toBe("/repos/alpha");
    expect(b).toBe("/repos/beta");
    expect(a).not.toBe(b);
  });

  it("优先用结构化 source 识别自家注入", () => {
    // source 命中 —— 主判据（v4 的 producer-owned kind）
    expect(
      isDshHarnessMessage({ sourceKind: DSH_PLUGIN_SOURCE_KIND }),
    ).toBe(true);
    // 兼容 v4 之前落盘的历史写法（kind="plugin" + plugin="autopilot"）
    expect(
      isDshHarnessMessage({
        sourceKind: "plugin",
        sourcePlugin: DSH_PLUGIN_SOURCE,
      }),
    ).toBe(true);
    // 其它插件不算
    expect(
      isDshHarnessMessage({ sourceKind: "plugin", sourcePlugin: "rewind" }),
    ).toBe(false);
    // 真实用户输入不算
    expect(isDshHarnessMessage({ sourceKind: "user" })).toBe(false);
    // 文本前缀回退：即使 source 缺失也能识别
    expect(
      isDshHarnessMessage({ prompt: "Review fix round 1: ..." }),
    ).toBe(true);
    expect(isDshHarnessMessage({ prompt: "普通用户消息" })).toBe(false);
  });

  it("注入消息的 source.kind 绝不为 v4 禁止的 \"plugin\"", () => {
    // 回归：DSH session 格式 v4 在接纳新消息时拒绝 kind==="plugin"，
    // 报 "format v4 message requires a producer-owned source kind"。
    // 该写法曾导致会话内任何自然语言输入都「本轮运行失败」。
    expect(DSH_PLUGIN_SOURCE_KIND).not.toBe("plugin");
    expect(DSH_PLUGIN_SOURCE_KIND).toMatch(/^plugin:/);
    expect(DSH_PLUGIN_SOURCE_KIND).toBe(`plugin:${DSH_PLUGIN_SOURCE}`);
  });

  it("buildPluginMessage 产出的消息可被 v4 接纳（真实注入形状）", () => {
    // 断言真正的构造结果，而不只是常量：即使有人把 buildPluginMessage
    // 改回字面量 "plugin"，这条测试也必须失败。
    const message = buildPluginMessage("autopilot 注入内容");
    const source = (message as { source?: { kind?: string; plugin?: unknown } })
      .source;

    expect(source?.kind).toBe(DSH_PLUGIN_SOURCE_KIND);
    expect(source?.kind).not.toBe("plugin");
    // 旧 wrapper 的 plugin 字段必须不再出现（v4 已淘汰该写法）
    expect(source).not.toHaveProperty("plugin");
    expect(message).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "autopilot 注入内容" }],
    });

    // 回归：注入消息必须自带唯一 id。缺 id 的消息一旦落盘，重开会话时
    // 持久化层会抛 `session event at seq N lacks an identified message`，
    // 整个会话被判为损坏（历史事故：30 条 review/命令消息无 id）。
    const id = (message as { id?: unknown }).id;
    expect(typeof id).toBe("string");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // 每次构造都必须是新 id，否则 inbox 去重会命中
    // `message "<id>" is already pending`
    expect((buildPluginMessage("x") as { id?: unknown }).id).not.toBe(id);

    // 与读取端对称：注入的消息必须能被识别为「自家消息」，
    // 否则 autopilot 会把自己的注入当作用户输入，导致循环。
    expect(isDshHarnessMessage({ sourceKind: source?.kind })).toBe(true);
  });

  it("从 tool_input 抽取路径并解析相对路径", () => {
    expect(filePathsFromDshToolInput({ file_path: "src/a.ts" })).toEqual([
      "src/a.ts",
    ]);
    // Pi/Claude 风格的多种键名
    expect(filePathsFromDshToolInput({ path: "b.ts" })).toEqual(["b.ts"]);
    expect(filePathsFromDshToolInput({ notebook_path: "n.ipynb" })).toEqual([
      "n.ipynb",
    ]);
    expect(filePathsFromDshToolInput({})).toEqual([]);
    expect(filePathsFromDshToolInput(null)).toEqual([]);
    // 相对路径按 cwd 解析
    expect(
      filePathsFromDshToolInput({ file_path: "src/a.ts" }, "/proj"),
    ).toEqual([path.resolve("/proj", "src/a.ts")]);
    // 去重
    expect(
      filePathsFromDshToolInput({ file_path: "/p/x.ts", path: "/p/x.ts" }),
    ).toEqual(["/p/x.ts"]);
  });

  it("构造 needPick 候选消息", () => {
    const msg = buildNeedPickMessage(undefined, [
      { slug: "track-a" },
      { slug: "track-b" },
    ]);
    expect(msg).toContain("track-a");
    expect(msg).toContain("track-b");
    // 无候选时给出 fallback 文案
    const empty = buildNeedPickMessage(undefined, []);
    expect(typeof empty).toBe("string");
    expect(empty.length).toBeGreaterThan(0);
  });
});

describe("dsh-autopilot 提交钩子（agent/pre-step）", () => {
  it("缺失 conversationId 时不做任何事", () => {
    const root = tmpRoot();
    initProject(root);
    const store = new StateStore(root);
    try {
      expect(handleDshSubmit(store, {}, root)).toEqual({});
      expect(handleDshSubmit(store, { conversationId: "" }, root)).toEqual({});
    } finally {
      store.close();
    }
  });

  it("自家注入消息只补 stamp，不再驱动状态机（防自激）", () => {
    const root = tmpRoot();
    initProject(root);
    const store = new StateStore(root);
    try {
      // stamp 只作用于已存在会话（不凭空建孤儿行），先建一条
      store.upsertSession({ conversation_id: "s1", project_root: root, platform: "cursor" });
      const r = handleDshSubmit(
        store,
        {
          conversationId: "s1",
          prompt: "Review fix round 1: anything",
          sourceKind: "plugin",
          sourcePlugin: DSH_PLUGIN_SOURCE,
        },
        root,
      );
      expect(r).toEqual({});
      // 会话被 stamp 为 dsh
      expect(store.getSession("s1")?.platform).toBe(DSH_PLATFORM);
    } finally {
      store.close();
    }
  });

  it("识别 /autopilot-on 并进入 planning", () => {
    const root = tmpRoot();
    initProject(root);
    const store = new StateStore(root);
    try {
      handleDshSubmit(
        store,
        { conversationId: "s2", prompt: "/autopilot-on", sourceKind: "user" },
        root,
      );
      const session = store.getSession("s2");
      expect(session).not.toBeNull();
      expect(session?.phase).toBe("planning");
      expect(session?.platform).toBe(DSH_PLATFORM);
    } finally {
      store.close();
    }
  });

  it("识别 /autopilot-off 并回到 off", () => {
    const root = tmpRoot();
    initProject(root);
    const store = new StateStore(root);
    try {
      handleDshSubmit(
        store,
        { conversationId: "s3", prompt: "/autopilot-on", sourceKind: "user" },
        root,
      );
      handleDshSubmit(
        store,
        { conversationId: "s3", prompt: "/autopilot-off", sourceKind: "user" },
        root,
      );
      // OFF 对 planning 的语义：phase 保留，但 armed=0 / paused=1（核心设计）
      const after = store.getSession("s3");
      expect(after).not.toBeNull();
      expect(after?.armed).toBe(0);
      expect(after?.paused).toBe(1);
    } finally {
      store.close();
    }
  });

  it("命令消息必须用 user 来源，否则会被自身跳过（回归锁定）", () => {
    const root = tmpRoot();
    initProject(root);
    const store = new StateStore(root);
    try {
      // 模拟命令 handler 发出的消息：user 来源 → 应生效
      handleDshSubmit(
        store,
        {
          conversationId: "cmd-user",
          prompt: "/autopilot-on cmd-track 测试",
          sourceKind: "user",
        },
        root,
      );
      expect(store.getSession("cmd-user")?.phase).toBe("planning");

      // plugin 来源 → 视为自家续跑消息，必须跳过（不驱动状态机）
      handleDshSubmit(
        store,
        {
          conversationId: "cmd-plugin",
          prompt: "/autopilot-on cmd-track 测试",
          sourceKind: "plugin",
          sourcePlugin: "autopilot",
        },
        root,
      );
      expect(store.getSession("cmd-plugin")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("普通用户消息不改变 phase", () => {
    const root = tmpRoot();
    initProject(root);
    const store = new StateStore(root);
    try {
      handleDshSubmit(
        store,
        { conversationId: "s4", prompt: "帮我看看这段代码", sourceKind: "user" },
        root,
      );
      // 未 ON 的普通消息不该凭空建会话（stamp 仅作用于已存在会话）
      expect(store.getSession("s4")).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("dsh-autopilot 工具钩子（tools/post-execute）", () => {
  it("非编辑工具不 arm review", () => {
    const root = tmpRoot();
    initProject(root);
    const store = new StateStore(root);
    try {
      store.upsertSession({ conversation_id: "t1", project_root: root });
      handleDshToolResult(
        store,
        { conversationId: "t1", toolName: "bash", toolInput: null },
        root,
      );
      expect(store.getSession("t1")?.platform).toBe(DSH_PLATFORM);
    } finally {
      store.close();
    }
  });

  it("编辑工具会 arm code_edited", () => {
    const root = tmpRoot();
    initProject(root);
    const store = new StateStore(root);
    try {
      store.upsertSession({ conversation_id: "t2", project_root: root });
      const file = path.join(root, "src", "a.ts");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "export const a = 1;\n");

      handleDshToolResult(
        store,
        {
          conversationId: "t2",
          toolName: "write",
          toolInput: { file_path: file },
          cwd: root,
        },
        root,
      );
      const session = store.getSession("t2");
      expect(session?.platform).toBe(DSH_PLATFORM);
      // code_edited 记录在 review chain 上，不在 session 上
      expect(store.getReviewChain("t2")?.code_edited).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("dsh-autopilot 停止钩子（agent/turn-stopping）", () => {
  it("缺失 conversationId 时返回空", () => {
    const root = tmpRoot();
    initProject(root);
    const store = new StateStore(root);
    const engine = testEngine(store, root);
    try {
      expect(
        handleDshTurnStopping(engine, store, { conversationId: "" }, root),
      ).toEqual({});
    } finally {
      store.close();
    }
  });

  it("未进入 ON 的普通停止不产生 steer", () => {
    const root = tmpRoot();
    initProject(root);
    const store = new StateStore(root);
    const engine = testEngine(store, root);
    try {
      const r = handleDshTurnStopping(
        engine,
        store,
        { conversationId: "z1", status: "completed", loopCount: 0 },
        root,
      );
      // reviewScope=executing_only 且未 RUN → 不续跑
      expect(r.steerMessage).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("返回形状是 steerMessage 而不是 decision/reason", () => {
    const root = tmpRoot();
    initProject(root);
    const store = new StateStore(root);
    const engine = testEngine(store, root);
    try {
      const r = handleDshTurnStopping(
        engine,
        store,
        { conversationId: "z2", status: "completed", loopCount: 0 },
        root,
      );
      // DSH 用 steer 续跑，绝不能出现 block 决策字段
      expect(r).not.toHaveProperty("decision");
      expect(r).not.toHaveProperty("reason");
      expect(Object.keys(r).every((k) => k === "steerMessage")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("error 状态可被引擎识别", () => {
    const root = tmpRoot();
    initProject(root);
    const store = new StateStore(root);
    const engine = testEngine(store, root);
    try {
      const r = handleDshTurnStopping(
        engine,
        store,
        { conversationId: "z3", status: "error", loopCount: 0 },
        root,
      );
      // 错误路径不应抛异常（fail-open）
      expect(r).toBeDefined();
    } finally {
      store.close();
    }
  });
});
