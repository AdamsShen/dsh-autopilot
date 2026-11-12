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
/** 最小初始化写入的文件（相对项目根）。 */
export interface MinimalInitResult {
    performed: boolean;
    written: string[];
    reason: string;
}
/**
 * 执行最小初始化。幂等：`.autopilot/config.yml` 已存在则跳过。
 *
 * @param projectRoot - 已解析出的项目根（调用方负责安全校验）
 * @param locale - 写入 config 的语言
 */
export declare function minimalInit(projectRoot: string, locale?: "en" | "zh-CN"): MinimalInitResult;
//# sourceMappingURL=minimal-init.d.ts.map