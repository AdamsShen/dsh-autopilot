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
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StateStore, createConfiguredReviewEngine } from "@autopilot-harness/core";
import { autoInitProject, isAlreadyInitialized } from "./auto-init.js";
import { DSH_PLUGIN_SOURCE_KIND, conversationIdFromDshPayload, handleDshSubmit, handleDshToolResult, handleDshTurnStopping, isDshHarnessMessage, resolveDshWorkspaceRoot, } from "./index.js";
export const name = "autopilot";
/** 可选配置面。schemastery 缺席时 Config 为 undefined，不影响运行态。 */
export let Config;
try {
    const Schema = (await import("@deepseek-ai/schemastery")).default;
    Config = Schema.object({
        projectRoot: Schema.string().description("强制钉死 Autopilot 项目根（含 .autopilot/）。默认留空：按每个会话自己的工作目录（session.header.cwd）自动判定，支持同一 DSH 进程服务多个项目。"),
        maxSteerPerTurn: Schema.number()
            .default(32)
            .description("单个 turn 内最大续跑次数，防止异常循环。"),
        autoInit: Schema.boolean()
            .default(false)
            .description("【已废弃，默认关闭】自动初始化。默认 false：插件不会在你的项目里创建任何文件。请用 /autopilot-enable 或工作区菜单显式启用当前项目。"),
    }).description("Autopilot Harness");
}
catch {
    Config = undefined;
}
/**
 * 从 DSH agent 上抽取会话标识。
 * DSH 保证 agent.id === agent.session.id。
 */
function agentKey(agent) {
    const id = agent?.id ?? agent?.session?.id;
    return typeof id === "string" ? id : "";
}
/** 从 DSH 的 Message 上抽取纯文本。 */
function textOfMessage(message) {
    const content = message?.content;
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const block of content) {
        const b = block;
        if (b?.type === "text" && typeof b.text === "string")
            parts.push(b.text);
    }
    return parts.join("\n");
}
/**
 * 安全日志：优先用宿主注入的 ctx.logger，其次 console.warn，最后静默。
 * 日志本身绝不允许抛出（否则会破坏 fail-open 契约）。
 */
function makeLog(ctx) {
    const logger = ctx.logger;
    return (level, msg) => {
        try {
            const text = `[autopilot] ${msg}`;
            const fn = logger?.[level];
            if (typeof fn === "function") {
                fn(text);
                return;
            }
            if (level === "warn" && typeof console !== "undefined") {
                console.warn(text);
            }
        }
        catch {
            /* logging must never throw */
        }
    };
}
/**
 * 构造一条插件来源的 UserMessage。
 * `source.kind` 必须是 v4 认可的生产者自有取值（见 DSH_PLUGIN_SOURCE_KIND），
 * 否则宿主接纳消息时会抛出
 * `format v4 message requires a producer-owned source kind`。
 * 该结构化 source 同时让 autopilot 后续能可靠识别自身注入，
 * 不依赖文本前缀（spike2/3 证实 source 会持久化并可回读）。
 *
 * `id` 必填：DSH 落盘 `user/message` 时不补 id，而重新打开会话时
 * 持久化层会逐条校验 `typeof message.id === "string"`，缺失即抛
 * `session event at seq N lacks an identified message`，整个会话打不开。
 * inbox 待处理队列也按 id 去重，两条无 id 消息同时排队会命中
 * `message "undefined" is already pending`。
 */
export function buildPluginMessage(text) {
    return {
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: DSH_PLUGIN_SOURCE_KIND, form: "notice" },
    };
}
export function apply(ctx, config = {}) {
    const log = makeLog(ctx);
    // 默认关闭：必须是显式 true 才自动初始化。
    // 绝不在用户没要求的项目里创建 .autopilot/。
    const autoInitEnabled = config.autoInit === true;
    /**
     * 每个项目根一套状态（StateStore + ReviewEngine）。
     *
     * 为什么按项目缓存而不是全局单例：
     *   DSH 是全局安装的插件，同一个宿主进程会同时服务多个不同项目的会话。
     *   每个项目需要自己的 `.autopilot/state.db` 与 vendor 运行时。
     *   用 Map 缓存，键是**规范化后的项目根**。
     */
    const projects = new Map();
    /** 已尝试过 auto-init 的项目根，避免每次钩子都重试。 */
    const initAttempted = new Set();
    /** config.yml 的轻量指纹（mtime+size）；缺失时返回空串。 */
    const configFingerprint = (root) => {
        try {
            const st = fs.statSync(path.join(root, ".autopilot", "config.yml"), {
                throwIfNoEntry: false,
            });
            return st ? `${st.mtimeMs}:${st.size}` : "";
        }
        catch {
            return "";
        }
    };
    /**
     * 解析本次交互的项目根，并按需建好该项目的状态。
     *
     * 关键：`sessionCwd` 来自会话 header，不是进程 cwd。
     */
    const projectFor = (sessionCwd) => {
        const root = resolveDshWorkspaceRoot({
            sessionCwd,
            configuredRoot: config.projectRoot,
        });
        if (!root)
            return null;
        const cached = projects.get(root);
        if (cached) {
            // 配置可能在缓存之后才出现或被修改（例如 auto-init 刚写好 config.yml）。
            // 用 config.yml 的 mtime+size 做轻量指纹，变了就重建 engine，
            // 否则 review.scope 之类的设置会一直停留在首次加载时的快照。
            if (cached.fingerprint === configFingerprint(root)) {
                return { root, ...cached };
            }
            try {
                cached.store.close();
            }
            catch {
                /* ignore */
            }
            projects.delete(root);
        }
        // ⚠️ 关键守卫：StateStore 的构造会创建 `.autopilot/state.db`。
        // 项目未启用时**绝不能**走到这里，否则就会在用户没要求的目录里建文件。
        // 启用判定 = 存在 `.autopilot/config.yml`（由 /autopilot-enable 或手动 init 产生）。
        if (!isAlreadyInitialized(root)) {
            // 若用户开启了 autoInit（显式 true），才在这里补做初始化。
            if (autoInitEnabled && !initAttempted.has(root)) {
                initAttempted.add(root);
                void autoInitProject({
                    configuredRoot: config.projectRoot ?? root,
                    cwd: root,
                    locale: "zh-CN",
                }).then((result) => {
                    if (result.performed) {
                        log("info", `auto-init 完成: ${result.projectRoot}`);
                    }
                });
            }
            return null;
        }
        let store;
        try {
            store = new StateStore(root);
        }
        catch {
            return null;
        }
        let engine;
        try {
            engine = createConfiguredReviewEngine(store, root);
        }
        catch {
            try {
                store.close();
            }
            catch {
                /* ignore */
            }
            return null;
        }
        const entry = { store, engine, fingerprint: configFingerprint(root) };
        projects.set(root, entry);
        return { root, ...entry };
    };
    /** 从 DSH agent 上取会话真实工作目录。 */
    const sessionCwdOf = (agent) => {
        const header = agent
            ?.session?.header;
        const cwd = header?.cwd;
        return typeof cwd === "string" && cwd.trim() ? cwd.trim() : null;
    };
    const maxSteer = Number.isFinite(config.maxSteerPerTurn)
        ? Math.max(1, Math.min(256, config.maxSteerPerTurn))
        : 32;
    /** agent.id → 自维护状态 */
    const states = new Map();
    const stateOf = (key) => {
        let s = states.get(key);
        if (!s) {
            s = { loopCount: 0, lastTurn: -1, status: "completed", steerInFlight: false };
            states.set(key, s);
        }
        return s;
    };
    // —— 会话生命周期：清理按 agent 的状态 ——
    ctx.on("agent/disposed", (payload) => {
        const key = agentKey(payload?.agent ?? {});
        if (key)
            states.delete(key);
    });
    // —— 错误/取消标记：turn-stopping 读取后决定 status ——
    ctx.on("agent/error", (payload) => {
        const key = agentKey(payload?.agent ?? {});
        if (key)
            stateOf(key).status = "error";
    });
    // —— 提交 / 预步：识别 /autopilot-* 触发 ——
    //
    // ⚠️ 被门禁拒绝的提示词是**替换**掉，不是用 `agent.inject()` 追加提示：
    //   1) 宿主文档明确 inject 只对「下一个 pre-step」生效，当前步的 batch 已经
    //      认领完毕，所以提示会晚一步才进模型视野；
    //   2) inject 只是旁白，原始 prompt 仍会进入模型（"Rejected" 名不副实）。
    //   改为返回 `{ kind: "enter", messages }`：DSH 的 pre-step 语义允许替换进入
    //      该 step 的消息，因此原 prompt 被丢弃、通知在**当前步**立刻可见。
    ctx.on("agent/pre-step", async (payload, next) => {
        const decision = await next();
        try {
            const key = agentKey(payload?.agent ?? {});
            // 上游已拒绝（别的 listener 决定不进这一步）时不得改写成 enter。
            if (!key || decision?.kind !== "enter")
                return decision;
            // ⚠️ pre-step 在同一 turn 的每个 step 前都会触发（spike 证实）。
            // 因此 loopCount 必须跨 step 累积，只在**换了新 turn** 时归零；
            // 早先按每次 pre-step 归零会导致预算永不耗尽、并掩盖真实轮次。
            const state = stateOf(key);
            const turn = typeof payload?.turn === "number" ? payload.turn : -1;
            if (turn !== state.lastTurn) {
                state.loopCount = 0;
                state.lastTurn = turn;
            }
            state.status = "completed";
            const kept = [];
            const notices = [];
            for (const message of decision.messages) {
                const source = message
                    ?.source;
                // 非本插件处理的来源（自注入续跑、runtime-context 等）原样放行。
                if (isDshHarnessMessage({ sourceKind: source?.kind, sourcePlugin: source?.plugin }) ||
                    (source?.kind && source.kind !== "user")) {
                    kept.push(message);
                    continue;
                }
                const project = projectFor(sessionCwdOf(payload?.agent));
                if (!project) {
                    kept.push(message);
                    continue;
                }
                const result = handleDshSubmit(project.store, {
                    conversationId: key,
                    prompt: textOfMessage(message),
                    sourceKind: source?.kind ?? "user",
                    sourcePlugin: source?.plugin ?? null,
                }, project.root);
                if (result.injectMessage) {
                    // 门禁拒绝：原始提示词不进模型，替换为通知（保持原有顺序：通知在后）。
                    notices.push(buildPluginMessage(result.injectMessage));
                    continue;
                }
                kept.push(message);
            }
            if (notices.length === 0)
                return decision;
            return { ...decision, messages: [...kept, ...notices] };
        }
        catch {
            // 钩子异常必须 fail-open：绝不让宿主回合因 autopilot 崩溃
            return decision;
        }
    });
    // —— 工具执行后：arm 写类工具 ——
    ctx.on("tools/post-execute", async (exec, result, next) => {
        try {
            const agent = exec?.agent;
            const key = agentKey(agent ?? {});
            if (key) {
                const project = projectFor(sessionCwdOf(agent));
                if (project) {
                    const args = exec?.arguments;
                    handleDshToolResult(project.store, {
                        conversationId: key,
                        toolName: exec?.name ?? null,
                        toolInput: args ?? null,
                        cwd: project.root,
                    }, project.root);
                }
            }
        }
        catch {
            /* fail-open */
        }
        return next();
    });
    // —— 核心续跑点：turn-stopping 内 steer ——
    ctx.on("agent/turn-stopping", (payload) => {
        try {
            const agent = payload?.agent;
            const key = agentKey(agent ?? {});
            if (!key || !agent)
                return;
            const state = stateOf(key);
            // 同一步重复进入保护：steer 已经投递但 loop 尚未回到本钩子
            if (state.steerInFlight)
                return;
            const convId = conversationIdFromDshPayload({ conversationId: key });
            if (!convId)
                return;
            // 按会话所属项目取状态——绝不能退回进程 cwd
            const project = projectFor(sessionCwdOf(agent));
            if (!project)
                return;
            const result = handleDshTurnStopping(project.engine, project.store, {
                conversationId: convId,
                status: state.status,
                loopCount: state.loopCount,
            }, project.root);
            if (!result.steerMessage)
                return;
            if (state.loopCount >= maxSteer)
                return;
            state.loopCount += 1;
            state.steerInFlight = true;
            try {
                // DSH 语义：steer → next-step 队列，机器重读 inbox 后继续跑一步
                agent.steer?.(buildPluginMessage(result.steerMessage));
            }
            finally {
                // steer 是同步投递，投递完成后即可解锁
                state.steerInFlight = false;
            }
        }
        catch {
            /* fail-open：钩子异常不得中断回合关闭 */
        }
    });
    const ok = (text) => text === undefined ? { kind: "success" } : { kind: "success", text };
    const fail = (text) => ({ kind: "error", text });
    for (const [commandName, hint] of [
        ["autopilot-enable", "在当前项目启用 Autopilot（会创建 .autopilot/）"],
        ["autopilot-on", "开始规划（grill 提问）"],
        ["autopilot-run", "开始执行清单"],
        ["autopilot-off", "关闭自动驾驶"],
        ["autopilot-replan", "修改方案"],
        ["autopilot-resume", "恢复执行"],
    ]) {
        try {
            ctx.inject(["commands"], (scoped) => {
                const commands = scoped.get("commands");
                if (!commands?.register)
                    return;
                commands.register({
                    name: commandName,
                    description: hint,
                    handler: async (invocation) => {
                        // /autopilot-enable 是唯一会写磁盘的命令：只有用户显式调用才建
                        // .autopilot/。它必须 await 完成后再返回，这样用户立刻就能拿到
                        // 成功/失败结果，而不是看到一个「进行中」的空承诺。
                        if (commandName === "autopilot-enable") {
                            const root = sessionCwdOf(invocation?.agent) ?? "";
                            if (!root) {
                                return fail("无法确定当前项目目录。请在该项目的会话里执行本命令。");
                            }
                            if (isAlreadyInitialized(root)) {
                                return ok(`本项目已启用 Autopilot：${root}`);
                            }
                            const result = await autoInitProject({
                                configuredRoot: root,
                                cwd: root,
                                locale: "zh-CN",
                            });
                            if (result.performed) {
                                log("info", `已启用 Autopilot: ${result.projectRoot}`);
                                return ok(`已在 ${result.projectRoot} 启用 Autopilot。\n` +
                                    `接下来可以用 /autopilot-on 开始规划。`);
                            }
                            log("warn", `启用失败(${root}): ${result.reason}`);
                            return fail(`启用失败：${result.reason}`);
                        }
                        // 其它命令把等价的文本投回对话，由 pre-step 统一识别，
                        // 这样命令路径与文本触发路径共用同一套状态机（单一事实源）。
                        //
                        // ⚠️ 消息必须标记为 **user** 来源，不能是 plugin：
                        // pre-step 会跳过 plugin 来源的消息（那是 Autopilot 自己的续跑
                        // 指令，不该再触发一次状态机）。命令是**用户意图**。
                        // `id` 必填，理由同 buildPluginMessage：缺 id 的命令回环消息
                        // 一旦落盘，重新打开会话时会被持久化层判为会话损坏。
                        const key = agentKey(invocation?.agent ?? {});
                        if (!key)
                            return fail("无法确定当前会话。");
                        const rest = (invocation?.rawInput ?? "").trim();
                        const text = `/${commandName}${rest ? " " + rest : ""}`;
                        try {
                            invocation.agent?.followup?.({
                                id: randomUUID(),
                                role: "user",
                                content: [{ type: "text", text }],
                                source: { kind: "user" },
                            });
                        }
                        catch (err) {
                            return fail(`命令投递失败：${err instanceof Error ? err.message : String(err)}`);
                        }
                        return ok();
                    },
                });
            });
        }
        catch {
            /* 命令系统缺席不影响钩子路径 */
        }
    }
}
//# sourceMappingURL=plugin.js.map