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

import path from "node:path";
import {
  applyOff,
  applyOn,
  applyReplan,
  applyResume,
  applyResumeReview,
  applyRun,
  applyTrackPick,
  ensureAmbientReviewSession,
  effectiveReviewingItemId,
  firstUnchecked,
  isChannelANeedPick,
  isHarnessFollowupMessage,
  isProductCodeEdit,
  isRecoverOrStuckFollowupMessage,
  loadProjectHookConfig,
  loadProjectReviewConfig,
  notePlansDirEdit,
  parseAdvanceNextItemId,
  parseChecklist,
  parseTrigger,
  type PhaseActionConfig,
  type ReviewEngine,
  type StateStore,
} from "@autopilot-harness/core";

export const DSH_PLATFORM = "dsh";

/**
 * 插件注入消息的 `source.plugin` 取值。
 * DSH 把 source 持久化进 session.events 且可回读（spike2/3 证实），
 * 所以识别自身注入用结构化 source 而不是文本前缀。
 */
export const DSH_PLUGIN_SOURCE = "autopilot";

/**
 * 插件注入消息的 `source.kind` 取值。
 *
 * 为什么不能再用 `"plugin"`：
 *   DSH 的 session 格式 v4 在接纳新消息时执行
 *   `format v4 message requires a producer-owned source kind`，
 *   明确拒绝 `kind === "plugin"` 的 retired wrapper 写法
 *   （v3→v4 迁移层会把旧的 `kind:"plugin"` 改写掉，但**新写入**的消息不经过迁移）。
 *   继续用 `"plugin"` 会让 autopilot 每次注入都抛出该错误，
 *   表现为会话内任何自然语言输入都「本轮运行失败」。
 *
 * 为什么是 `plugin:${DSH_PLUGIN_SOURCE}`：
 *   v4 的 kind 是开放取值，只要求「由生产者自己拥有」。
 *   DSH 迁移层对未在内置清单中的第三方插件正是采用 `plugin:<name>` 形态，
 *   这里保持同构，且与既有磁盘数据中的 `plugin:autopilot` 兼容。
 */
export const DSH_PLUGIN_SOURCE_KIND = `plugin:${DSH_PLUGIN_SOURCE}`;

/**
 * DSH 无已知的 stop-continue 硬性上限（无 loop_limit / BLOCK_CAP）。
 * 因此不 clamp confirm_rounds —— 与 Cursor / Claude Code 同级。
 */
export const DSH_STOP_CAP_RAISE_FOUND = false;

/** 内置可写文件工具名（post-execute 命中即 arm）。 */
export const DSH_EDIT_TOOLS = Object.freeze([
  "write",
  "edit",
  "apply_patch",
  "notebook_edit",
] as const);

export const MAX_NEED_PICK_SLUGS = 40;
export const MAX_NEED_PICK_CONTEXT_CHARS = 2_000;
export const MAX_HOOK_TEXT_CHARS = 8_192;
export const MAX_DSH_PATH_CHARS = 4_096;
export const MAX_DSH_PATHS = 256;

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

function clipText(text: string, max = MAX_HOOK_TEXT_CHARS): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated]`;
}

function isSafePath(p: string): boolean {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    p.length <= MAX_DSH_PATH_CHARS &&
    !p.includes("\u0000")
  );
}

/** DSH agent.id 即会话标识；缺失时不做任何状态变更。 */
export function conversationIdFromDshPayload(p: {
  conversationId?: string | null;
}): string {
  const raw = typeof p.conversationId === "string" ? p.conversationId.trim() : "";
  if (!raw || raw.length > 256 || raw.includes("\u0000")) return "";
  return raw;
}

export function isDshEditTool(toolName: unknown): boolean {
  if (typeof toolName !== "string") return false;
  return (DSH_EDIT_TOOLS as readonly string[]).includes(toolName);
}

/**
 * 是否为本插件此前注入的消息。
 * 优先用结构化 source（spike 证实可持久化），文本前缀仅作回退。
 */
export function isDshHarnessMessage(p: {
  prompt?: string | null;
  sourceKind?: string | null;
  sourcePlugin?: string | null;
}): boolean {
  // 新格式：kind 为 producer-owned 的 `plugin:autopilot`，不再带 plugin 字段。
  if (p.sourceKind === DSH_PLUGIN_SOURCE_KIND) {
    return true;
  }
  // 兼容 v4 之前落盘的历史消息：kind="plugin" + plugin="autopilot"。
  if (p.sourceKind === "plugin" && p.sourcePlugin === DSH_PLUGIN_SOURCE) {
    return true;
  }
  const text = typeof p.prompt === "string" ? p.prompt : "";
  return isHarnessFollowupMessage(text);
}

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
export function resolveDshWorkspaceRoot(opts: {
  sessionCwd?: string | null;
  configuredRoot?: string | null;
  fallbackCwd?: string | null;
}): string | null {
  for (const v of [opts.sessionCwd, opts.configuredRoot, opts.fallbackCwd]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function stampDshPlatform(
  store: StateStore,
  conversationId: string,
  projectRoot: string,
): void {
  const session = store.getSession(conversationId);
  if (!session || session.platform === DSH_PLATFORM) return;
  store.upsertSession({
    conversation_id: conversationId,
    project_root: session.project_root || projectRoot,
    code_root: session.code_root || projectRoot,
    platform: DSH_PLATFORM,
  });
}

function gateMessage(userMessage: unknown, fallback: string): string {
  if (typeof userMessage === "string" && userMessage.trim()) {
    return clipText(userMessage.trim());
  }
  return fallback;
}

export function buildNeedPickMessage(
  userMessage: unknown,
  candidates?: ReadonlyArray<{ slug?: string }>,
): string {
  const fromMessage =
    typeof userMessage === "string" && userMessage.trim()
      ? userMessage.trim()
      : "";
  const slugs: string[] = [];
  if (Array.isArray(candidates)) {
    for (const c of candidates) {
      const slug = typeof c?.slug === "string" ? c.slug.trim() : "";
      if (!slug) continue;
      if (!slugs.includes(slug)) slugs.push(slug);
      if (slugs.length >= MAX_NEED_PICK_SLUGS) break;
    }
  }
  const head =
    fromMessage ||
    "[Autopilot] Multiple tracks found. Reply with the slug you want, then `/autopilot-run`.";
  if (slugs.length === 0) return clipText(head);
  const body = slugs.map((s) => `- ${s}`).join("\n");
  return clipText(`${head}\n\n${body}`, MAX_NEED_PICK_CONTEXT_CHARS);
}

/**
 * `agent/pre-step` —— 识别 /autopilot-* 触发并驱动状态机。
 * 返回需要注入的消息（门禁提示 / needPick 候选）；正常路径返回空对象放行。
 */
export function handleDshSubmit(
  store: StateStore,
  payload: DshSubmitPayload,
  projectRoot: string,
  portConfig?: DshPortConfig,
): DshSubmitResult {
  const conversationId = conversationIdFromDshPayload(payload);
  if (!conversationId) return {};

  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";

  // 自家续跑消息：只补 stamp，绝不再触发一次状态机（防自激）。
  if (isDshHarnessMessage(payload)) {
    stampDshPlatform(store, conversationId, projectRoot);
    return {};
  }

  try {
    store.clearPendingFollowupIf(
      conversationId,
      isRecoverOrStuckFollowupMessage,
    );
  } catch {
    /* best-effort */
  }

  const session = store.getSession(conversationId);
  const hookCfg = loadProjectHookConfig(projectRoot);
  const trigger = parseTrigger({
    prompt,
    conversationId,
    projectRoot,
    pendingAction: session?.pending_action,
    triggers: hookCfg.triggers,
  });

  const actionConfig: PhaseActionConfig = {
    ...portConfig?.phaseActions,
    plansDir: portConfig?.phaseActions?.plansDir ?? hookCfg.plansDir,
  };
  const gateFallback =
    "[Autopilot] Rejected this prompt. Check `npx autopilot-harness status`.";

  if (trigger) {
    if (trigger.kind === "off") {
      applyOff(store, conversationId);
      stampDshPlatform(store, conversationId, projectRoot);
      return {};
    }
    if (trigger.kind === "on") {
      const result = applyOn(store, conversationId, projectRoot, {
        initialBrief: trigger.initialBrief,
        slug: trigger.slug,
        platform: DSH_PLATFORM,
      });
      stampDshPlatform(store, conversationId, projectRoot);
      if (!result.ok) {
        return { injectMessage: gateMessage(result.userMessage, gateFallback) };
      }
      return {};
    }
    if (trigger.kind === "resume") {
      const result = applyResume(store, conversationId, {
        slug: trigger.slug,
      });
      stampDshPlatform(store, conversationId, projectRoot);
      if (!result.ok) {
        return { injectMessage: gateMessage(result.userMessage, gateFallback) };
      }
      return {};
    }
    if (trigger.kind === "resume_review") {
      applyResumeReview(store, conversationId);
      stampDshPlatform(store, conversationId, projectRoot);
      return {};
    }
    if (trigger.kind === "run") {
      const result = applyRun(store, conversationId, projectRoot, {
        slug: trigger.slug,
        config: actionConfig,
        platform: DSH_PLATFORM,
      });
      stampDshPlatform(store, conversationId, projectRoot);
      if (!result.ok) {
        if (isChannelANeedPick(result)) {
          return {
            injectMessage: buildNeedPickMessage(
              result.userMessage,
              result.candidates,
            ),
          };
        }
        return { injectMessage: gateMessage(result.userMessage, gateFallback) };
      }
      return {};
    }
    if (trigger.kind === "replan") {
      const result = applyReplan(store, conversationId, projectRoot, {
        slug: trigger.slug,
        config: actionConfig,
        platform: DSH_PLATFORM,
      });
      stampDshPlatform(store, conversationId, projectRoot);
      if (!result.ok) {
        if (isChannelANeedPick(result)) {
          return {
            injectMessage: buildNeedPickMessage(
              result.userMessage,
              result.candidates,
            ),
          };
        }
        return { injectMessage: gateMessage(result.userMessage, gateFallback) };
      }
      return {};
    }
    if (trigger.kind === "track_pick" && trigger.trackPick) {
      const result = applyTrackPick(
        store,
        conversationId,
        projectRoot,
        trigger.trackPick,
        { config: actionConfig, platform: DSH_PLATFORM },
      );
      stampDshPlatform(store, conversationId, projectRoot);
      if (!result.ok) {
        if (isChannelANeedPick(result)) {
          return {
            injectMessage: buildNeedPickMessage(
              result.userMessage,
              result.candidates,
            ),
          };
        }
        return { injectMessage: gateMessage(result.userMessage, gateFallback) };
      }
      return {};
    }
    return {};
  }

  if (!isHarnessFollowupMessage(prompt)) {
    store.clearChainPending(conversationId);
  }
  stampDshPlatform(store, conversationId, projectRoot);
  return {};
}

function armCodeEdited(
  store: StateStore,
  conversationId: string,
  projectRoot: string,
): void {
  const cfg = loadProjectReviewConfig(projectRoot);
  if (cfg.reviewScope === "project") {
    ensureAmbientReviewSession(
      store,
      conversationId,
      projectRoot,
      cfg.reviewScope,
      DSH_PLATFORM,
    );
  }
  stampDshPlatform(store, conversationId, projectRoot);
  const session = store.getSession(conversationId);
  const checklistPath = session?.checklist_path?.trim() ?? "";
  let checklistSnap: ReturnType<typeof parseChecklist> | null = null;
  if (checklistPath) {
    try {
      checklistSnap = parseChecklist(checklistPath, { projectRoot });
    } catch {
      /* still arm */
    }
  }
  store.markCodeEdited(conversationId, (chain) => {
    const fromPending = parseAdvanceNextItemId(chain.pending_followup);
    if (checklistSnap) {
      if (fromPending && effectiveReviewingItemId(checklistSnap, fromPending)) {
        return fromPending;
      }
      return firstUnchecked(checklistSnap)?.id ?? null;
    }
    return fromPending;
  });
}

/** 从 DSH tool_input 里抽路径（write/edit 的常见键）。 */
export function filePathsFromDshToolInput(
  input: Record<string, unknown> | null | undefined,
  cwd?: string | null,
): string[] {
  if (!input || typeof input !== "object") return [];
  const keys = ["file_path", "filePath", "path", "notebook_path", "notebookPath"];
  const out: string[] = [];
  for (const key of keys) {
    const raw = (input as Record<string, unknown>)[key];
    if (typeof raw !== "string") continue;
    let p = raw.trim();
    if (!isSafePath(p)) continue;
    if (!path.isAbsolute(p)) {
      const base =
        typeof cwd === "string" && cwd.trim() ? cwd.trim() : undefined;
      if (base && isSafePath(base)) p = path.resolve(base, p);
    }
    if (!isSafePath(p)) continue;
    if (!out.includes(p)) out.push(p);
    if (out.length >= MAX_DSH_PATHS) break;
  }
  return out;
}

function armPaths(
  store: StateStore,
  conversationId: string,
  projectRoot: string,
  filePaths: readonly string[],
): void {
  if (filePaths.length === 0) {
    stampDshPlatform(store, conversationId, projectRoot);
    return;
  }
  let plansDir: string | undefined;
  try {
    plansDir = loadProjectHookConfig(projectRoot).plansDir;
  } catch {
    plansDir = undefined;
  }
  let armed = false;
  for (const filePath of filePaths) {
    try {
      notePlansDirEdit(store, conversationId, projectRoot, filePath, plansDir);
    } catch {
      /* best-effort */
    }
    if (!isProductCodeEdit(filePath, { projectRoot })) continue;
    if (!armed) {
      armCodeEdited(store, conversationId, projectRoot);
      armed = true;
    }
  }
  if (!armed) {
    stampDshPlatform(store, conversationId, projectRoot);
  }
}

/** `tools/post-execute` —— arm 写类工具；绝不阻断。 */
export function handleDshToolResult(
  store: StateStore,
  payload: DshToolPayload,
  projectRoot: string,
): void {
  const conversationId = conversationIdFromDshPayload(payload);
  if (!conversationId) return;
  if (!isDshEditTool(payload.toolName)) {
    stampDshPlatform(store, conversationId, projectRoot);
    return;
  }
  const paths = filePathsFromDshToolInput(payload.toolInput, payload.cwd);
  armPaths(store, conversationId, projectRoot, paths);
}

/**
 * `agent/turn-stopping` —— 核心续跑点。
 *
 * 返回 `steerMessage` 时，插件层必须调 `agent.steer(...)`；
 * 返回空对象时回合正常关闭。
 *
 * ⚠️ 轮次用调用方传进来的 `loopCount`（autopilot 自维护），
 *    不要改用 DSH 的 `payload.turn`——同一 turn 内该钩子会触发多次。
 */
export function handleDshTurnStopping(
  engine: ReviewEngine,
  store: StateStore,
  payload: DshStopPayload,
  projectRoot: string,
): DshStopResult {
  const conversationId = conversationIdFromDshPayload(payload);
  if (!conversationId) return {};

  stampDshPlatform(store, conversationId, projectRoot);

  const action = engine.handleStop({
    conversationId,
    status: payload.status ?? "completed",
    loopCount: payload.loopCount ?? 0,
    platform: DSH_PLATFORM,
  });

  const msg = typeof action?.message === "string" ? action.message.trim() : "";
  if (!msg || !action?.loop) return {};

  return { steerMessage: clipText(msg) };
}
