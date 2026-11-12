# Autopilot Harness for DeepSeek Harness (DSH)

把 **结构化规划 → 清单式执行 → 多视角自审** 接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，以进程内 DSH 插件的形式运行。

[English](./README.md)

> [Autopilot Harness](https://github.com/AdamsShen/autopilot-harness) 家族成员。核心引擎：[`@autopilot-harness/core`](https://www.npmjs.com/package/@autopilot-harness/core)。

---

## 它做什么

Autopilot 拦截 DSH 的回合边界（`agent/turn-stopping`）。当 agent 改完产品代码，它不会停下来等你，而是注入一条追问，继续走完五轮不同视角的自审。清单项干净后自动推进——本地 commit，不自动 push。

```
/autopilot-on  →  grill 提问  →  brief / plan / checklist
       ↓
/autopilot-run →  逐项：实现 → 修复 → 确认×N → 推进
       ↓
完成（清单清空）
```

| 视角 | 轮次 |
|---|---:|
| 正确性与不变量 | 1 |
| 空值、边界与错误路径 | 2 |
| 并发、竞态与部分失败 | 3 |
| 安全与信任边界 | 4 |
| 测试缺口与回归（只读） | 5 |

![Autopilot 拦截回合边界并注入自审](https://raw.githubusercontent.com/AdamsShen/dsh-autopilot-harness/main/docs/demo.png)

*真实输出：真实 DSH 宿主运行已发布的 `dsh-autopilot-harness@0.1.0`。*

---

## 为什么叫 Harness，它和别的 DSH Autopilot 插件有什么不同

DSH 上好些插件都叫 autopilot。这一个的身份是 **[Autopilot Harness](https://github.com/AdamsShen/autopilot-harness) 的 DeepSeek Harness 端口**——那个引擎已经服务于 Cursor、Claude Code、Codex、Kimi、Copilot CLI、Grok、Gemini CLI、Factory Droid、Hermes、Antigravity、Pi、Devin 和 runner。这个背景带来的差别：

| | 本插件 | 一般的「一直跑到达成」循环 |
|---|---|---|
| **介入时机** | 回合边界，且**只有改过产品代码**才介入 | 无条件持续循环 |
| **在边界做什么** | 跑**五个轮换的评审视角**，每轮焦点不同 | 重复同一条指令，直到看起来做完 |
| **依据什么判断** | 实际 diff、不变量、错误路径、竞态、信任边界、测试缺口 | agent 自己声称完成 |
| **规划** | `/autopilot-on` 走 grill 提问并写出 `brief.md` / `plan.md` / `checklist.md` | 通常没有，一个 prompt 一个循环 |
| **进度记录** | 仓库里的 `checklist.md` + SQLite 状态库 | 只在上下文里，重启即丢 |
| **状态边界** | 按项目隔离，以会话工作目录为键 | 常常是进程级 |
| **文件纪律** | 你执行 `/autopilot-enable` 之前**不写任何文件** | 各不相同 |

实际差别在于：普通续跑循环让 agent **说得更久**；Autopilot 让它**换一个它原本没用的角度再看一遍**，然后才推进。

### 它刻意不做什么

- **不是任务管理器。** 没有看板 UI、没有迭代规划。它就是一份清单加一台执行状态机。
- **不是测试框架。** 第 5 个视角**记录**测试缺口，不会自动生成测试。
- **不做无人值守的通宵作业。** 每一步推进都基于你能审阅的实际改动。
- **不联网、不需要凭据、不采集遥测。** 见[兼容性与权限](#兼容性与权限)。

---

## 快速开始（5 分钟）

```bash
# ① 安装（一次性）
dsh plugin --profile web add dsh-autopilot-harness

# ② 把下面这行加进 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles
#    "dsh-autopilot-harness"

# ③ 完全退出 DSH 再打开（Node 模块缓存需要重启）

# ④ 在目标项目的会话里启用（每个项目一次）
/autopilot-enable
```

到这里就生效了。**最直接的验证方式**：随便改一个源文件，然后什么都不说。几秒后 agent 应该自己开始自审——那就是 Autopilot 在工作。

想做一件有规划的功能，再走清单模式：

```
/autopilot-on user-login · 实现手机号+验证码登录
     ↓  回答几轮提问
     ↓  产出 docs/autopilot/plans/user-login/{brief,plan,checklist}.md
/autopilot-run
     ↓  逐项实现 → 自审 → 勾掉 → 本地 commit
```

---

## 安装

**从 npm 安装** —— 推荐，DSH 插件中心用的就是这条：

```bash
dsh plugin --profile web add dsh-autopilot-harness
```

**从源码安装**（尚未发 npm 也可用）：

```bash
dsh plugin --profile web add github:AdamsShen/dsh-autopilot-harness
```

`dist/` 已纳入版本控制，源码安装无需构建。

`plugin add` 只装依赖，**不会**自动追加 bundle 条目，需要手动加进 `~/.dsh/profiles/<profile>/package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-autopilot-harness"
      ]
    }
  }
}
```

验证组合结果：

```bash
dsh --profile <profile> --dump-config | grep autopilot-harness
```

然后**完全重启 DSH**。

> 安装插件**不会创建任何项目文件**。启用是显式动作，见下节。

---

## 启用项目

在目标项目的会话里执行：

```
/autopilot-enable
```

若 `@autopilot-harness/cli` 可用（全局或项目内），会执行完整 `init`；若不可用，插件自动做一次**最小本地初始化**——所以 `/autopilot-enable` 开箱即用。

| | 完整 init（有 CLI） | 最小 init（无 CLI） |
|---|---|---|
| `.autopilot/config.yml` | ✅ | ✅ |
| `.autopilotignore` | ✅ | ✅ |
| `docs/autopilot/{plans,specs}` | ✅ | ✅ |
| `docs/autopilot/workflows`、`quickstart.md` | ✅ | — |
| `.autopilot/bin/`（vendor 运行时 + 迁移） | ✅ | —（DSH 用不到） |

`state.db` 两种情况都在首次真正使用时惰性创建。

完整 `init` 产物：

```
<项目>/.autopilot/
├── config.yml      配置
├── state.db        SQLite：会话、评审链、清单进度
├── pin.json        版本锚点
└── bin/            钩子运行时与迁移
<项目>/docs/autopilot/
├── plans/          brief.md / plan.md / checklist.md
├── specs/          跨任务行为规格
└── workflows/      规划与执行指引
```

在 `.autopilot/config.yml` 存在之前，Autopilot 的所有钩子对该项目都是空操作。仅有 `state.db` **不算**已启用。

---

## 命令

| 命令 | 作用 |
|---|---|
| `/autopilot-enable` | 为当前项目执行 init（**唯一**写磁盘的命令） |
| `/autopilot-on [slug · 描述]` | 进入规划；grill 轮产出 brief/plan/checklist |
| `/autopilot-run` | 按清单逐项执行 |
| `/autopilot-off` | 暂停 |
| `/autopilot-replan` | 修改方案 |
| `/autopilot-resume` | 恢复执行 |

文字触发词同样有效，按行首匹配：`Autopilot ON`、`Autopilot RUN`、`Autopilot OFF`、`Autopilot RESUME`、`Autopilot REPLAN`、`开启自动驾驶`、`开始执行` …

`/autopilot-on` 参数规则：

- 单个 slug 形状的词 → 当作 track 名：`/autopilot-on user-login`
- 其它情况 → 整体作为需求描述，slug 稍后自动生成
- 要同时指定 → 用 `·`（间隔号）分隔：`/autopilot-on user-login · 实现手机号登录`

---

## 配置

项目级，`<项目>/.autopilot/config.yml`（下一步操作生效，无需重启）：

```yaml
review:
  scope: project        # project=任意产品代码改动都自审；executing_only=仅 RUN 期间
  confirm_rounds: 5     # 5=完整视角集；3=轻量（视角 1→2→5）
  verify:
    enabled: false      # 是否跑测试命令并记录结果
  stuck:
    max_idle_stops: 5
  errors:
    max_before_pause: 0 # 0=不因错误暂停
    recover: true
```

插件级，在 profile 的 bundle 条目里：

| 配置项 | 默认 | 含义 |
|---|---|---|
| `autoInit` | `false` | 自动初始化。保持 `false`，优先用 `/autopilot-enable` |
| `maxSteerPerTurn` | `32` | 单个 turn 最大续跑次数（防死循环） |
| `projectRoot` | 空 | 钉死项目根。一般留空——按会话自己的工作目录自动判定 |

---

## 与其它 Autopilot 端口的区别

其它宿主都用决策对象阻断 stop 事件。DSH 没有这种决策：`agent/turn-stopping` 是 **serial** 钩子，续跑靠数据副作用。

```ts
// 本端口的 stop 结果——不是 { decision, reason }
interface DshStopResult { steerMessage?: string }
```

插件调用 `agent.steer(message)`，DSH 的 loop 重读收件箱后继续跑一步。DSH 没有 stop 续跑上限，因此本端口**不 clamp** `review.confirm_rounds`。

两个值得知道的推论：

- `turn-stopping` 在**同一 turn 内会多次触发**，且 turn 号不变——轮次由内部自维护，绝不从 `payload.turn` 推导。
- **没有 `hooks.json`**。钩子在 `apply(ctx)` 里用 `ctx.on(...)` 以代码注册；`cordis.patch.yml` 只负责让 DSH 加载插件。

---

## 项目边界

DSH 插件全局安装，一个宿主进程会服务多个项目的会话。`process.cwd()` 是**宿主**目录，不是项目。本端口从会话自己的工作目录（`session.header.cwd`）解析项目，并按项目根缓存状态——两个项目的两个会话会得到两套独立的 `.autopilot/`。

---

## 兼容性与权限

| | |
|---|---|
| **能力分类** | 工作流与自动化 |
| **DSH 目标版本** | `>=0.2.1-rc.2 <0.3.0`（声明在 `engines.dsh`） |
| **平台** | macOS / Windows / Linux —— 纯 Node.js，无原生代码 |
| **Profile** | 任意 profile；示例用 `web` |
| **网络** | 无。插件不发起任何外部请求。 |
| **文件系统** | 只在**显式启用**的项目内写：`.autopilot/`、`docs/autopilot/`、`.autopilotignore`。`/autopilot-enable` 之前绝不写盘。 |
| **凭据** | 无。不需要 API Key 或 token。 |
| **外部服务** | 无 |

## 环境要求

- Node.js ≥ 22
- DSH ≥ 0.2.1-rc.2（< 0.3.0）
- 可选：`@autopilot-harness/cli`，用于完整 `init`（vendor 运行时、迁移、工作流文档）。没有它会退回**最小本地初始化**，只写 DSH 真正用到的部分。

---

## 开发

```bash
npm install
npm run typecheck
npm test               # 单测（44 项）
npm run test:e2e       # 起真实 DSH 宿主，23 项断言
npm run build
npm run check          # 以上全部 + npm pack --dry-run
```

`tests/e2e/` 把**构建产物**装进真实 DSH 宿主跑（真实 `AgentLoop`、`ToolRuntime`、`Commands`），而不是直接调 handler。宿主版本漂移就是靠它抓出来的——见 [tests/e2e/README.md](./tests/e2e/README.md)。

### 目录

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 纯适配层——不 import 任何 `@deepseek-ai/*`，完全可单测 |
| `src/plugin.ts` | DSH 插件入口（`name` / `Config` / `apply`）；唯一接触 DSH 类型的文件，且仅 `import type` |
| `src/auto-init.ts` | 可选的自动初始化，带安全护栏 |
| `src/dsh-events.d.ts` | 本地最小事件契约，让 DSH 保持可选 peer |
| `cordis.patch.yml` | DSH 组合进 profile 的 loader 条目 |

---

## 发布

```bash
npm run check
npm publish            # prepack 会自动构建
```

`files` 白名单包含 `dist/`、`cordis.patch.yml`、`assets/` 与两份 README。

---

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。