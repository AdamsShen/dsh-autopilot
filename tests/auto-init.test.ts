import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  autoInitProject,
  findGitRoot,
  isAlreadyInitialized,
  resolveAutoInitRoot,
} from "../src/auto-init.js";

function tmpProject(withGit = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-dsh-autinit-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"t"}\n');
  if (withGit) fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return root;
}

/** 假的 installInitYes：记录被调用的参数并写一个 config.yml。 */
function fakeInitYes(behavior: "ok" | "fail" | "throw" = "ok") {
  const calls: unknown[] = [];
  const fn = (opts: { projectRoot: string }) => {
    calls.push(opts);
    if (behavior === "throw") throw new Error("boom");
    if (behavior === "fail") return { ok: false, error: "simulated failure" };
    const dir = path.join(opts.projectRoot, ".autopilot");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yml"), "platforms:\n  - id: dsh\n");
    return { ok: true, written: [".autopilot/config.yml"] };
  };
  return { fn, calls };
}

describe("dsh auto-init：项目根解析", () => {
  it("从子目录向上找到 git 根", () => {
    const root = tmpProject(true);
    const deep = path.join(root, "src", "a", "b");
    fs.mkdirSync(deep, { recursive: true });
    expect(findGitRoot(deep)).toBe(root);
    expect(resolveAutoInitRoot({ cwd: deep })).toEqual({
      root,
      reason: "git repository root",
    });
  });

  it("没有 git 但像项目时退回 cwd", () => {
    const root = tmpProject(false);
    expect(resolveAutoInitRoot({ cwd: root })).toEqual({
      root,
      reason: "cwd (project-like)",
    });
  });

  it("既无 git 又不像项目时拒绝初始化", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "ap-dsh-bare-"));
    const r = resolveAutoInitRoot({ cwd: bare });
    expect(r.root).toBeNull();
    expect(r.reason).toContain("does not look like a project");
  });

  it("拒绝在根目录等危险位置初始化", () => {
    expect(resolveAutoInitRoot({ cwd: "/" }).root).toBeNull();
    expect(resolveAutoInitRoot({ configuredRoot: "/tmp" }).root).toBeNull();
    expect(resolveAutoInitRoot({ configuredRoot: "/" }).reason).toContain(
      "unsafe",
    );
  });

  it("显式 projectRoot 优先于 cwd", () => {
    const explicit = tmpProject(true);
    const other = tmpProject(false);
    expect(
      resolveAutoInitRoot({ configuredRoot: explicit, cwd: other }),
    ).toEqual({ root: explicit, reason: "explicit projectRoot" });
  });

  it("显式 projectRoot 不像项目时也拒绝", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "ap-dsh-bare2-"));
    const r = resolveAutoInitRoot({ configuredRoot: bare });
    expect(r.root).toBeNull();
    expect(r.reason).toContain("does not look like a project");
  });

  it("无 cwd 时不动手", () => {
    expect(resolveAutoInitRoot({}).root).toBeNull();
    expect(resolveAutoInitRoot({ cwd: "  " }).reason).toContain("no cwd");
  });
});

describe("dsh auto-init：幂等与失败处理", () => {
  it("未初始化时执行 init 并写入 config", async () => {
    const root = tmpProject();
    const { fn, calls } = fakeInitYes("ok");
    const r = await autoInitProject({
      cwd: root,
      locale: "zh-CN",
      deps: { loadInitYes: async () => fn },
    });
    expect(r.performed).toBe(true);
    expect(r.projectRoot).toBe(root);
    expect(r.written).toContain(".autopilot/config.yml");
    expect(calls).toHaveLength(1);
    // 传的是 dsh 平台
    expect((calls[0] as { platform: string }).platform).toBe("dsh");
    expect((calls[0] as { locale: string }).locale).toBe("zh-CN");
    expect(isAlreadyInitialized(root)).toBe(true);
  });

  it("已初始化时跳过，绝不重复调用 init", async () => {
    const root = tmpProject();
    const dir = path.join(root, ".autopilot");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yml"), "platforms: []\n");

    const { fn, calls } = fakeInitYes("ok");
    const r = await autoInitProject({
      cwd: root,
      deps: { loadInitYes: async () => fn },
    });
    expect(r.performed).toBe(false);
    expect(r.reason).toBe("already initialized");
    expect(calls).toHaveLength(0);
  });

  it("CLI 不可解析时退回最小初始化，而不是直接失败", async () => {
    const root = tmpProject();
    const r = await autoInitProject({
      cwd: root,
      deps: { loadInitYes: async () => null },
    });
    // 插件市场场景：没有 CLI 也必须能用
    expect(r.performed).toBe(true);
    expect(isAlreadyInitialized(root)).toBe(true);
  });

  it("init 返回失败时不抛异常", async () => {
    const root = tmpProject();
    const { fn } = fakeInitYes("fail");
    const r = await autoInitProject({
      cwd: root,
      deps: { loadInitYes: async () => fn },
    });
    expect(r.performed).toBe(false);
    expect(r.reason).toContain("init failed");
  });

  it("init 抛异常时 fail-open", async () => {
    const root = tmpProject();
    const { fn } = fakeInitYes("throw");
    const r = await autoInitProject({
      cwd: root,
      deps: { loadInitYes: async () => fn },
    });
    expect(r.performed).toBe(false);
    expect(r.reason).toContain("init threw");
  });

  it("不安全位置下完全不尝试加载 CLI", async () => {
    let loaded = false;
    const r = await autoInitProject({
      configuredRoot: "/",
      deps: {
        loadInitYes: async () => {
          loaded = true;
          return null;
        },
      },
    });
    expect(r.performed).toBe(false);
    expect(loaded).toBe(false);
    expect(r.reason).toContain("unsafe");
  });
});

describe("dsh auto-init：默认关闭（绝不在未启用的项目建文件）", () => {
  it("default 是 opt-in：不传 autoInit 时不初始化", async () => {
    const root = tmpProject();
    // 模拟插件默认行为：autoInit 未开启 → 根本不调用 autoInitProject
    // （插件的守卫会先检查 isAlreadyInitialized 再决定是否建 store）
    expect(isAlreadyInitialized(root)).toBe(false);
    // 未初始化时，任何未显式启用的路径都不该留下 .autopilot
    expect(fs.existsSync(path.join(root, ".autopilot"))).toBe(false);
  });

  it("显式初始化后才创建 config.yml", async () => {
    const root = tmpProject();
    const { fn } = fakeInitYes("ok");
    const r = await autoInitProject({
      cwd: root,
      deps: { loadInitYes: async () => fn },
    });
    expect(r.performed).toBe(true);
    expect(isAlreadyInitialized(root)).toBe(true);
  });

  it("启用判定只认 config.yml（state.db 不算已启用）", () => {
    const root = tmpProject();
    fs.mkdirSync(path.join(root, ".autopilot"), { recursive: true });
    // 只有 state.db（例如 StateStore 被误建）不算启用
    fs.writeFileSync(path.join(root, ".autopilot", "state.db"), "");
    expect(isAlreadyInitialized(root)).toBe(false);
    // 有 config.yml 才算
    fs.writeFileSync(path.join(root, ".autopilot", "config.yml"), "platforms: []\n");
    expect(isAlreadyInitialized(root)).toBe(true);
  });
});

describe("dsh auto-init：CLI 解析（全局 profile 场景）", () => {
  it("项目里装了 CLI 时，按 node_modules 布局解析并真正执行 init", async () => {
    const root = tmpProject();

    // 造一个最小可用的 @autopilot-harness/cli，形状与真实包一致：
    // package.json 声明 type=module，dist/index.js 导出 installInitYes。
    const cliRoot = path.join(root, "node_modules/@autopilot-harness/cli");
    fs.mkdirSync(path.join(cliRoot, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(cliRoot, "package.json"),
      JSON.stringify({ name: "@autopilot-harness/cli", type: "module", main: "./dist/index.js" }),
    );
    fs.writeFileSync(
      path.join(cliRoot, "dist/index.js"),
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        "export function installInitYes(opts) {",
        '  const dir = path.join(opts.projectRoot, ".autopilot");',
        "  if (opts.platform !== \"dsh\") return { ok: false, error: \"wrong platform\" };",
        "  fs.mkdirSync(dir, { recursive: true });",
        '  fs.writeFileSync(path.join(dir, "config.yml"), JSON.stringify({ platforms: [{ id: "dsh" }] }));',
        '  return { ok: true, written: [".autopilot/config.yml"] };',
        "}",
      ].join("\n"),
    );

    // 不注入 deps，走真实 loader：应当从项目 node_modules 解析到并完成初始化。
    const r = await autoInitProject({ cwd: root, locale: "zh-CN" });
    expect(r.performed).toBe(true);
    expect(r.reason).toBe("initialized");
    expect(isAlreadyInitialized(root)).toBe(true);
  });

  it("DSH_AUTOPILOT_CLI_PATH 可显式指定 CLI 入口", async () => {
    const root = tmpProject();
    const cliEntry = path.join(root, "fake-cli.mjs");
    fs.writeFileSync(
      cliEntry,
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        "export function installInitYes(opts) {",
        '  const dir = path.join(opts.projectRoot, ".autopilot");',
        "  fs.mkdirSync(dir, { recursive: true });",
        '  fs.writeFileSync(path.join(dir, "config.yml"), JSON.stringify({ via: "env" }));',
        '  return { ok: true, written: [".autopilot/config.yml"] };',
        "}",
      ].join("\n"),
    );

    const prev = process.env.DSH_AUTOPILOT_CLI_PATH;
    process.env.DSH_AUTOPILOT_CLI_PATH = cliEntry;
    try {
      const r = await autoInitProject({ cwd: root, locale: "zh-CN" });
      expect(r.performed).toBe(true);
      expect(r.reason).toBe("initialized");
    } finally {
      if (prev === undefined) delete process.env.DSH_AUTOPILOT_CLI_PATH;
      else process.env.DSH_AUTOPILOT_CLI_PATH = prev;
    }
  });

  it("关闭兜底时，解析失败给出可诊断的原因且不创建目录", async () => {
    const root = tmpProject();
    const r = await autoInitProject({
      cwd: root,
      deps: { loadInitYes: async () => null },
      allowMinimalFallback: false,
    });
    expect(r.performed).toBe(false);
    expect(r.reason).toContain("not resolvable");
    expect(fs.existsSync(path.join(root, ".autopilot"))).toBe(false);
  });

  it("CLI 缺失时退回最小初始化（开箱即用）", async () => {
    const root = tmpProject();
    const r = await autoInitProject({
      cwd: root,
      deps: { loadInitYes: async () => null },
      allowMinimalFallback: true,
    });
    expect(r.performed).toBe(true);
    expect(r.reason).toContain("minimal");
    // 必须写出可用的 config
    expect(isAlreadyInitialized(root)).toBe(true);
    const cfg = fs.readFileSync(
      path.join(root, ".autopilot", "config.yml"),
      "utf8",
    );
    expect(cfg).toContain("id: dsh");
    expect(cfg).toContain("confirm_rounds: 5");
    // 也要铺好计划目录
    expect(
      fs.existsSync(path.join(root, "docs/autopilot/plans/README.md")),
    ).toBe(true);
    // 但**不该**写 DSH 用不到的 vendor runtime
    expect(fs.existsSync(path.join(root, ".autopilot/bin"))).toBe(false);
  });
});
