/**
 * dsh-autopilot/plugin —— DSH (DeepSeek Harness) 插件入口。
 *
 * 这是唯一 import `@deepseek-ai/*` 的文件，且全部为 `import type`（编译期擦除），
 * 运行时只依赖 cordis 传入的 ctx。若 DSH 升级导致类型漂移，
 * 影响范围被限制在本文件，纯函数层（index.ts）不受影响。
 *
 * 装配方式（~/.dsh/cordis.patch.yml）：
 *   - insert:
 *       - id: autopilot
 *         name: 'dsh-autopilot/plugin'
 *         config:
 *           projectRoot: (留空)   # 默认按会话 cwd 自动判定项目
 *
 * 钩子接法（spike 实测 21/21 通过）：
 *   - agent/pre-step      → 识别 /autopilot-* 触发，驱动状态机
 *   - tools/post-execute  → arm 写类工具
 *   - agent/turn-stopping → 核心续跑点，用 agent.steer() 而非 block
 */
import type { Context } from "@deepseek-ai/cordis";
export declare const name = "autopilot";
/** 可选配置面。schemastery 缺席时 Config 为 undefined，不影响运行态。 */
export declare let Config: unknown;
interface AutopilotPluginConfig {
    projectRoot?: string;
    maxSteerPerTurn?: number;
    /** 检测到项目却未初始化时自动建 .autopilot/（默认 true，幂等，fail-open）。 */
    autoInit?: boolean;
}
export declare function apply(ctx: Context, config?: AutopilotPluginConfig): void;
export {};
//# sourceMappingURL=plugin.d.ts.map