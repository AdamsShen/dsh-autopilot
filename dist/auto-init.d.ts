/**
 * DSH 端口的「自动初始化」支持。
 *
 * 背景：其它宿主的 `autopilot-harness init` 会写 hooks.json + skills，
 * 用户必须手动跑一次。DSH 是进程内插件，插件 `apply()` 时已经能拿到
 * 项目根，因此可以顺手把 `.autopilot/` 建好，省掉一次手动 CLI 调用。
 *
 * 设计原则（重要）：
 *   1. **默认不做破坏性初始化。** 只有显式开启 autoInit 才尝试。
 *   2. **只在一个可信锚点上初始化。** 优先 git 仓库根；没有 git 就退回 cwd，
 *      但要求 cwd 看起来是个真实项目（有 package.json / .git / 常见源码目录）。
 *      避免在 `/`、`~`、`/tmp` 这种位置凭空造 .autopilot。
 *   3. **幂等。** 已存在 `.autopilot/config.yml` 时直接跳过，不覆盖用户配置。
 *   4. **可失败静默。** 初始化失败绝不能让宿主启动失败（fail-open）。
 *   5. **不硬依赖 CLI 包。** 通过动态 import 尝试加载 `@autopilot-harness/cli`；
 *      加载不到就跳过（DSH profile 里通常只有 port 包，没有 CLI 全家桶）。
 */
/** 初始化结果，用于诊断与测试断言。 */
export interface DshAutoInitResult {
    /** 是否实际执行了初始化（false = 跳过，原因见 reason）。 */
    performed: boolean;
    /** 解析出的项目根。 */
    projectRoot: string | null;
    /** 跳过/失败原因（诊断用，不影响宿主）。 */
    reason: string;
    /** 初始化成功时写入的文件相对路径。 */
    written: readonly string[];
}
/**
 * 从起点向上找 git 仓库根。找到返回根，找不到返回 null。
 * 只认 `.git` 目录或 `.git` 文件（worktree 的情况）。
 */
export declare function findGitRoot(start: string): string | null;
/**
 * 决定在哪里初始化。
 *
 * 优先级：
 *   1. 显式传入的 projectRoot（用户配置的最强意图）
 *   2. 从 cwd 向上找到的 git 根
 *   3. cwd 本身 —— 仅当它看起来像项目
 *
 * @returns 项目根，或 null 表示不该初始化
 */
export declare function resolveAutoInitRoot(opts: {
    configuredRoot?: string | null;
    cwd?: string | null;
}): {
    root: string | null;
    reason: string;
};
/** 已有 `.autopilot/config.yml` 视为已初始化。 */
export declare function isAlreadyInitialized(projectRoot: string): boolean;
type InitYesFn = (opts: {
    projectRoot: string;
    platform: string;
    surface: string;
    platforms?: ReadonlyArray<{
        id: string;
        surface: string;
    }>;
    locale: string;
    force: boolean;
    packageVersion?: string;
    writeQuickstart?: boolean;
}) => {
    ok: boolean;
    written?: readonly string[];
    error?: string;
};
/**
 * 执行自动初始化（幂等、fail-open）。
 *
 * @param opts.configuredRoot 插件配置里的 projectRoot（可为空）
 * @param opts.cwd DSH 进程工作目录
 * @param opts.locale 写入 config.yml 的 locale
 * @param opts.deps 可选注入，测试用（避免真的去 import CLI 包）
 */
export declare function autoInitProject(opts: {
    configuredRoot?: string | null;
    cwd?: string | null;
    locale?: "en" | "zh-CN";
    deps?: {
        loadInitYes?: () => Promise<InitYesFn | null>;
    };
    /**
     * CLI 不可解析时，是否退回到 DSH 自足的最小初始化。
     * 默认 true —— 插件市场里的包必须能开箱即用。
     */
    allowMinimalFallback?: boolean;
}): Promise<DshAutoInitResult>;
export {};
//# sourceMappingURL=auto-init.d.ts.map