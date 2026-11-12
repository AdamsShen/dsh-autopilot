# 端到端测试

不再把插件当源码，而是当**已构建的产物**装进真实 DSH 宿主里跑完整生命周期。

```bash
npm run test:e2e     # 会先 build，再跑 lifecycle 与 safety 两套
```

## 为什么要单独一套

`tests/*.test.ts` 是单测：纯函数、可注入依赖、毫秒级。它们守不住下面这些问题：

- `AgentLoop` 在 `turn-stopping` 之后到底有没有真的再跑一步
- `tools/post-execute` 在**真实工具调用**下会不会触发（单测里是手工调用的）
- 命令返回的对象在真实 `commands.execute()` 里合不合法
- `.autopilot/` 会不会在用户没同意的项目里被创建

这些只有把宿主整个起起来才看得见。所以这一层的价值不是覆盖率，而是**证伪**。

## 两套用例

| 文件 | 覆盖 |
|---|---|
| `lifecycle.mjs` | 未启用零侵入 → 显式启用 → 规划 → 改代码 → 自动自审 → 关闭 → 多项目隔离（15 项） |
| `safety.mjs` | 跨进程持久化、启用幂等、危险目录拒写、非项目目录拒写、启用判据（8 项） |

`harness.mjs` 是公共设施：造临时项目、起宿主、拦截 `steer`、汇总断言。

## 跑在哪个 DSH 版本上

`devDependencies` 里锁的是 **0.2.2-rc.1**，与 `peerDependencies` 声明的区间一致。

**这一点很重要**：这套测试最初是在 `0.1.0-rc.6` 上写的，迁到 0.2.2-rc.1 时暴露了四处 API 漂移——

| 变化 | 影响 |
|---|---|
| `LlmService` → `LlmRuntime` | 导入名 |
| 新增 `sessionProjections` 服务 | `AgentRegistry` 依赖它，否则插件不激活 |
| `tools.execute` 收「一批调用」 | 入参从 `{callId,name,arguments}` 变成 `{calls:[tool-call 块]}` |
| 工具需执行器插件 | 不挂 `@deepseek-ai/dsh-tool-executor-native` 会抛 `TOOL_EXECUTOR_UNAVAILABLE` |

如果只跑单测，这些全都发现不了。

## 两个实现细节

**验证「自动续跑」不看会话日志。**
会话事件在不同版本里形态不一（`events` / `eventsSnapshot`），所以拦截 `agent.steer()`——那是「要求循环继续」的唯一出口，跨版本稳定。

**插件从 `dist/` 加载，不从源码。**
这样测的是实际发布产物，能抓到 `tsc` 输出、`exports` 映射一类只在打包后暴露的问题。

## 已知边界

- **不覆盖浏览器 UI**。渲染层没有自动化，`/autopilot-enable` 在 GUI 里点击的效果仍需人工确认。
- **不覆盖从 npm/GitHub 安装**。那是一次性的分发验证（`dsh plugin add github:...`），不适合放进日常回归。
- **模型是假的**。`ScriptedLlm` 只吐固定文本，因此自审内容的质量不在测试范围内——这里只验证链路是否通畅。