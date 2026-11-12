/**
 * E2E · 安全与持久化
 *
 * 这些是"出错代价很高"的行为，必须独立守住：
 *   - 重启后仍认得出已启用的项目
 *   - 重复启用不会重复写
 *   - 拒绝在系统目录或非项目目录里动手
 *   - 启用判据只看 config.yml（光有 state.db 不算）
 *
 * auto-init 不是包的公开导出（exports 只暴露 `.` 与 `./plugin`），
 * 这里按相对文件路径导入，测的仍是打包后的产物。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { StateStore } from "@autopilot-harness/core";

import { cleanup, createChecker, makeProject, sleep } from "./harness.mjs";

const { autoInitProject, isAlreadyInitialized } = await import(
  "../../dist/auto-init.js"
);
const { bootHost, openSession, say } = await import("./harness.mjs");

const { check, summary } = createChecker();

// ── 持久化：启用后重开状态库仍能读到历史 ──────────────────────────
const project = makeProject("e2e-persist");
const first = await autoInitProject({
  configuredRoot: project,
  cwd: project,
  locale: "zh-CN",
});
check("① 首次启用成功", first.performed, first.reason);

{
  // 真正需要持久化的东西是 Autopilot 自己的状态：phase、武装标记、评审链。
  // 所以先让它进入 planning，再"换一个进程"（新 StateStore）读回来。
  const pluginModule = await import("../../dist/plugin.js");
  const host = await bootHost({ pluginModule });
  const s = await openSession(host, "e2e-persist-1", project);
  await say(s.handle, "你好");
  await sleep(400);
  await host.commands.execute(
    s.handle.agent,
    "/autopilot-on persist-track 持久化验证",
    [],
    new AbortController().signal,
  );
  await s.handle.agent.whenIdle();
  await sleep(400);

  const phaseBefore = new StateStore(project).getSession(s.conversationId)?.phase;

  // 换一个 StateStore 实例，等价于另一个进程打开同一个 state.db
  const reopened = new StateStore(project);
  const phaseAfter = reopened.getSession(s.conversationId)?.phase;
  check(
    "② phase 跨进程持久化",
    phaseBefore === "planning" && phaseAfter === "planning",
    `${phaseBefore} → ${phaseAfter}`,
  );

  reopened.close();
  await s.handle.dispose();
  await host.dispose();
}

// ── 幂等 ──────────────────────────────────────────────────────────
{
  const before = fs.readdirSync(path.join(project, ".autopilot")).sort().join(",");
  const again = await autoInitProject({
    configuredRoot: project,
    cwd: project,
    locale: "zh-CN",
  });
  const after = fs.readdirSync(path.join(project, ".autopilot")).sort().join(",");
  check("③ 重复启用是幂等的", !again.performed && before === after, again.reason);
}

// ── 危险目录防护 ──────────────────────────────────────────────────
{
  const unsafe = await autoInitProject({
    configuredRoot: "/tmp",
    cwd: "/tmp",
    locale: "zh-CN",
  });
  check("④ 拒绝在 /tmp 这类危险目录初始化", !unsafe.performed, unsafe.reason);
  check("⑤ 且确实没有写入 /tmp/.autopilot", !isAlreadyInitialized("/tmp"));
}

// ── 非项目目录防护 ────────────────────────────────────────────────
{
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-bare-"));
  const r = await autoInitProject({ cwd: bare, locale: "zh-CN" });
  check(
    "⑥ 无项目标记的空目录不初始化",
    !r.performed && !fs.existsSync(path.join(bare, ".autopilot")),
    r.reason,
  );
  cleanup(bare);
}

// ── 启用判据只看 config.yml ───────────────────────────────────────
{
  const fake = makeProject("e2e-signal");
  fs.mkdirSync(path.join(fake, ".autopilot"), { recursive: true });
  fs.writeFileSync(path.join(fake, ".autopilot", "state.db"), "");
  check("⑦ 仅有 state.db 不算已启用", !isAlreadyInitialized(fake));

  fs.writeFileSync(path.join(fake, ".autopilot", "config.yml"), "platforms: []\n");
  check("⑧ 有 config.yml 才算已启用", isAlreadyInitialized(fake));
  cleanup(fake);
}

cleanup(project);
process.exit(summary() ? 0 : 1);