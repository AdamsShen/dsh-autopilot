/**
 * dsh-autopilot — DeepSeek Harness (DSH) in-process plugin adapters.
 *
 * 与其它 port 的根本差异：
 *   1. DSH 的 `agent/turn-stopping` 是 **serial** 钩子，不返回 block 决策，
 *      而是靠 listener 调 `agent.steer()` 产生数据副作用，机器随后重读 inbox
 *      并在有 next-step 时继续跑一步（spike 实测 21/21 通过）。
 *   2. 因此本 port 的 stop 结果形状是 `{ steerMessage?: string }`，不是
 *      `{ decision: "block", reason }`。
 *   3. `turn-stopping` 在**同一个 turn 内会多次触发**（turn 号不变），
 *      轮次一定由 autopilot 自己的 loopCount 决定，绝不读 payload.turn。
 *
 * 本文件不 import 任何 `@deepseek-ai/*`，纯函数便于单测；
 * DSH 类型只在 plugin.ts 以 `import type` 出现（编译期擦除）。
 *
 * Spike 证据：/tmp/dsh-spike/spike{,2,3}.mjs（21 项断言全部通过）。
 */
import { type PhaseActionConfig, type ReviewEngine, type StateStore } from "@autopilot-harness/core";
export declare const DSH_PLATFORM = "dsh";
/**
 * 插件注入消息的 `source.plugin` 取值。
 * DSH 把 source 持久化进 session.events 且可回读（spike2/3 证实），
 * 所以识别自身注入用结构化 source 而不是文本前缀。
 */
export declare const DSH_PLUGIN_SOURCE = "autopilot";
/**
 * DSH 无已知的 stop-continue 硬性上限（无 loop_limit / BLOCK_CAP）。
 * 因此不 clamp confirm_rounds —— 与 Cursor / Claude Code 同级。
 */
export declare const DSH_STOP_CAP_RAISE_FOUND = false;
/** 内置可写文件工具名（post-execute 命中即 arm）。 */
export declare const DSH_EDIT_TOOLS: readonly ["write", "edit", "apply_patch", "notebook_edit"];
export declare const MAX_NEED_PICK_SLUGS = 40;
export declare const MAX_NEED_PICK_CONTEXT_CHARS = 2000;
export declare const MAX_HOOK_TEXT_CHARS = 8192;
export declare const MAX_DSH_PATH_CHARS = 4096;
export declare const MAX_DSH_PATHS = 256;
export interface DshPortConfig {
    phaseActions?: PhaseActionConfig;
}
/** `agent/pre-step` 侧看到的提交信息（插件层从 DSH 消息里抽取）。 */
export interface DshSubmitPayload {
    /** agent.id === session.id，DSH 注册表强制校验。 */
    conversationId?: string | null;
    /** 用户/插件输入文本。 */
    prompt?: string | null;
    /** DSH Message.source.kind：user | plugin | model | tool。 */
    sourceKind?: string | null;
    /** source.kind === "plugin" 时的插件名。 */
    sourcePlugin?: string | null;
}
/** `tools/post-execute` 侧的编辑信息。 */
export interface DshToolPayload {
    conversationId?: string | null;
    toolName?: string | null;
    toolInput?: Record<string, unknown> | null;
    /** 工作目录，用于解析相对路径。 */
    cwd?: string | null;
}
/** `agent/turn-stopping` 侧的停止信息。 */
export interface DshStopPayload {
    conversationId?: string | null;
    /** 由插件层依据 error/aborted 事实推导。 */
    status?: "completed" | "error" | "aborted";
    /** autopilot 自维护的链轮次（不要取 DSH 的 turn 号）。 */
    loopCount?: number;
}
/**
 * stop 结果：需要续跑时给出一条 steer 文本。
 * DSH 没有 block 决策，插件层拿到文本后调 `agent.steer(...)`。
 */
export interface DshStopResult {
    steerMessage?: string;
}
export interface DshSubmitResult {
    /** 需要立刻回灌给用户的门禁提示（作为注入消息发出）。 */
    injectMessage?: string;
}
/** DSH agent.id 即会话标识；缺失时不做任何状态变更。 */
export declare function conversationIdFromDshPayload(p: {
    conversationId?: string | null;
}): string;
export declare function isDshEditTool(toolName: unknown): boolean;
/**
 * 是否为本插件此前注入的消息。
 * 优先用结构化 source（spike 证实可持久化），文本前缀仅作回退。
 */
export declare function isDshHarnessMessage(p: {
    prompt?: string | null;
    sourceKind?: string | null;
    sourcePlugin?: string | null;
}): boolean;
/**
 * 解析「当前这次交互属于哪个项目」。
 *
 * ⚠️ 这是本端口最关键的边界判定。
 * DSH 是**全局安装**的插件，它的 `process.cwd()` 是宿主进程自己的目录，
 * 与用户正在编辑的项目没有任何关系。若用它做项目根，`.autopilot/`
 * 会建到错误位置。
 *
 * 正确的来源是**每个会话自带的 cwd**（`session.header.cwd`，DSH 在
 * 会话创建时记录，见 dsh-session `SessionHeader.cwd`）。
 * 一个 DSH 进程可以同时服务多个不同项目的会话，因此状态必须按会话
 * 的项目根隔离，而不是插件加载时算一次。
 *
 * 优先级：
 *   1. `sessionCwd` —— 会话真实工作目录（正确来源）
 *   2. `configuredRoot` —— 用户显式在插件配置里钉死的根（覆盖用）
 *   3. `fallbackCwd` —— 兜底，仅当以上都没有；调用方应尽量避免传入
 */
export declare function resolveDshWorkspaceRoot(opts: {
    sessionCwd?: string | null;
    configuredRoot?: string | null;
    fallbackCwd?: string | null;
}): string | null;
export declare function buildNeedPickMessage(userMessage: unknown, candidates?: ReadonlyArray<{
    slug?: string;
}>): string;
/**
 * `agent/pre-step` —— 识别 /autopilot-* 触发并驱动状态机。
 * 返回需要注入的消息（门禁提示 / needPick 候选）；正常路径返回空对象放行。
 */
export declare function handleDshSubmit(store: StateStore, payload: DshSubmitPayload, projectRoot: string, portConfig?: DshPortConfig): DshSubmitResult;
/** 从 DSH tool_input 里抽路径（write/edit 的常见键）。 */
export declare function filePathsFromDshToolInput(input: Record<string, unknown> | null | undefined, cwd?: string | null): string[];
/** `tools/post-execute` —— arm 写类工具；绝不阻断。 */
export declare function handleDshToolResult(store: StateStore, payload: DshToolPayload, projectRoot: string): void;
/**
 * `agent/turn-stopping` —— 核心续跑点。
 *
 * 返回 `steerMessage` 时，插件层必须调 `agent.steer(...)`；
 * 返回空对象时回合正常关闭。
 *
 * ⚠️ 轮次用调用方传进来的 `loopCount`（autopilot 自维护），
 *    不要改用 DSH 的 `payload.turn`——同一 turn 内该钩子会触发多次。
 */
export declare function handleDshTurnStopping(engine: ReviewEngine, store: StateStore, payload: DshStopPayload, projectRoot: string): DshStopResult;
//# sourceMappingURL=index.d.ts.map