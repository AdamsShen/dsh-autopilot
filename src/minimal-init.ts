/**
 * DSH 端口的「最小本地初始化」。
 *
 * 为什么需要它：
 *   `init` 的完整实现位于 `@autopilot-harness/cli`（要写 vendor runtime、
 *   跑迁移、铺全部门户文档）。本插件独立发包后，用户机器上常常**没有** CLI，
 *   于是 `/autopilot-enable` 会失败——对一个插件市场里的包来说这是不可接受的。
 *
 *   所以这里提供一个 DSH **自足**的最小初始化：只写本端口真正会用到的东西。
 *   CLI 可用时仍然优先用 CLI（完整产物、与其它宿主一致）；CLI 缺失时才降级到这里。
 *
 * 写什么 / 不写什么：
 *   写：.autopilot/config.yml、.autopilotignore、docs/autopilot/{plans,specs}/README.md
 *   不写：.autopilot/bin/**（DSH 是进程内插件，用不到 shell 钩子运行时）
 *   不写：state.db（首次真正使用时由 StateStore 惰性创建）
 *
 * 刻意保持极简：任何「多写」都可能与 CLI 的真实产物产生漂移。
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AUTOPILOT_IGNORE_TEXT } from "@autopilot-harness/core";

/** 最小初始化写入的文件（相对项目根）。 */
export interface MinimalInitResult {
  performed: boolean;
  written: string[];
  reason: string;
}

const CONFIG_TEMPLATE = (locale: string): string => `# Autopilot Harness — 项目配置
#
# 由 dsh-autopilot 的最小初始化生成（本机没有 autopilot-harness CLI）。
# 想获得与其它宿主完全一致的产物（vendor runtime、迁移、门户文档），
# 安装 CLI 后重跑：npx @autopilot-harness/cli init --platform dsh --force
platforms:
  - id: dsh
    surface: cli
integration: hook
locale: ${locale}

artifacts:
  plans_dir: docs/autopilot/plans
  specs_dir: docs/autopilot/specs
  files:
    brief: brief.md
    plan: plan.md
    checklist: checklist.md

concurrency:
  mode: one_executor
  worktree: false

review:
  # project = 任意产品代码改动都自审；executing_only = 仅 RUN 期间
  scope: project
  # 5 = 完整五个视角；3 = 轻量（视角 1→2→5）
  confirm_rounds: 5
  verify:
    enabled: false
  stuck:
    max_idle_stops: 5
  errors:
    # 连续出错多少次暂停；0 = 永不暂停
    max_before_pause: 0
    recover: true

triggers:
  match: line_start
  on: ["Autopilot ON", "Enable autopilot", "开启自动驾驶"]
  run: ["Autopilot RUN", "Start execution", "开始执行"]
  off: ["Autopilot OFF", "Disable autopilot", "关闭自动驾驶"]
  resume: ["Autopilot RESUME", "继续执行"]
  replan: ["Autopilot REPLAN", "修改方案"]
  resume_review: ["Resume review", "继续自审"]

security:
  require_token: false
`;

const PLANS_README = `# Plans

\`/autopilot-on\` 在此目录下按 track 生成产物：

\`\`\`
<slug>/
├── brief.md      需求摘要
├── plan.md       实现方案
└── checklist.md  可勾选清单（进度权威来源）
\`\`\`

\`checklist.md\` 中 **行首** 的 \`- [ ]\` / \`- [x]\` 是唯一被解析的条目格式；
缩进的补充说明（Paths / Done when / Verify）不会被视为条目。
`;

const SPECS_README = `# Specs

跨 track 的行为规格放在这里。

\`artifacts.specs_dir\` 指向本目录；其中的文件同样被排除在「产品代码」判定之外，
因此编辑规格不会触发自审。
`;

/**
 * 执行最小初始化。幂等：`.autopilot/config.yml` 已存在则跳过。
 *
 * @param projectRoot - 已解析出的项目根（调用方负责安全校验）
 * @param locale - 写入 config 的语言
 */
export function minimalInit(
  projectRoot: string,
  locale: "en" | "zh-CN" = "zh-CN",
): MinimalInitResult {
  const root = path.resolve(projectRoot);
  const autopilotDir = path.join(root, ".autopilot");
  const configPath = path.join(autopilotDir, "config.yml");

  try {
    const st = fs.statSync(configPath, { throwIfNoEntry: false });
    if (st?.isFile()) {
      return { performed: false, written: [], reason: "already initialized" };
    }
  } catch {
    /* 继续尝试创建 */
  }

  const written: string[] = [];

  try {
    fs.mkdirSync(autopilotDir, { recursive: true });
    fs.writeFileSync(configPath, CONFIG_TEMPLATE(locale), { mode: 0o644 });
    written.push(".autopilot/config.yml");
  } catch (err) {
    return {
      performed: false,
      written,
      reason: `write config failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // .autopilotignore：只在缺失时写，绝不覆盖用户改动
  try {
    const ignorePath = path.join(root, ".autopilotignore");
    const st = fs.statSync(ignorePath, { throwIfNoEntry: false });
    if (!st) {
      fs.writeFileSync(ignorePath, DEFAULT_AUTOPILOT_IGNORE_TEXT, {
        mode: 0o644,
      });
      written.push(".autopilotignore");
    }
  } catch {
    /* best-effort */
  }

  // 计划/规格目录骨架
  for (const [rel, body] of [
    [path.join("docs", "autopilot", "plans"), PLANS_README],
    [path.join("docs", "autopilot", "specs"), SPECS_README],
  ] as const) {
    try {
      const dir = path.join(root, rel);
      fs.mkdirSync(dir, { recursive: true });
      const readme = path.join(dir, "README.md");
      if (!fs.statSync(readme, { throwIfNoEntry: false })) {
        fs.writeFileSync(readme, body, { mode: 0o644 });
        written.push(path.posix.join(rel.split(path.sep).join("/"), "README.md"));
      }
    } catch {
      /* best-effort */
    }
  }

  return { performed: true, written, reason: "minimal local init" };
}