/**
 * DSH 事件契约的类型声明（编译期补充）。
 *
 * 为什么需要这个文件：
 *   DSH 的事件名通过 `declare module '@deepseek-ai/cordis' { interface Events {...} }`
 *   做模块增强，只有 import 了 `@deepseek-ai/dsh-agent` 才会被 tsc 看见。
 *   但 dsh-autopilot 不把 `@deepseek-ai/*` 作为硬依赖（它们是 rc 版本、peer 链复杂、
 *   且运行时由宿主提供），所以本文件把用到的**最小事件面**在本地补齐。
 *
 * 约束（重要）：
 *   - 这里只做形状声明，不引入任何运行时依赖，`import type` 编译期擦除。
 *   - 事件形状必须与 DSH `dsh-agent@0.1.0-rc.6` 的 runtime-types.d.ts 保持一致；
 *     已有契约测试 `tests/dsh-contract.test.ts` 在不装 DSH 包时校验本文件的稳定性，
 *     若 DSH 升级导致签名漂移，需要同步更新本文件。
 *   - 只声明本 port 实际订阅的事件，不追求覆盖全集。
 *
 * 对应 DSH 源（核对日期 2026-11）：
 *   packages/dsh-agent/lib/types/runtime-types.d.ts:301  'agent/turn-stopping'
 *   packages/dsh-agent/lib/types/runtime-types.d.ts       'agent/error'
 *   packages/dsh-agent/lib/types/runtime-types.d.ts       'agent/disposed'
 *   packages/dsh-agent/lib/types/runtime-types.d.ts       'agent/pre-step'
 *   packages/dsh-tools/lib/types/index.d.ts:61            'tools/post-execute'
 */

declare module "@deepseek-ai/cordis" {
  interface Events {
    /** agent 离开注册表（驱动静止之后）。 */
    "agent/disposed"(payload: { agent: DshAgentLike }): void;

    /** 某回合内发生错误。 */
    "agent/error"(payload: {
      agent: DshAgentLike;
      turn: number;
      step: number;
      error: unknown;
    }): void;

    /**
     * 回合即将关闭：模型不再欠响应。
     * waterfall 模式；listener 通过 `agent.inject()` 追加本步上下文。
     */
    "agent/pre-step"(
      payload: {
        agent: DshAgentLike;
        messages: readonly DshMessageLike[];
        turn: number;
        step: number;
        signal: AbortSignal;
      },
      next: () => Promise<
        | { kind: "reject" }
        | { kind: "enter"; messages: readonly DshMessageLike[] }
      >,
    ): Promise<
      | { kind: "reject" }
      | { kind: "enter"; messages: readonly DshMessageLike[] }
    >;

    /**
     * 回合即将关闭时触发（serial 模式）。
     * 续跑方式：listener 调 `agent.steer()` 投递数据，机器随后重读 inbox。
     * ⚠️ 同一 turn 内会多次触发，turn 号不变。
     */
    "agent/turn-stopping"(payload: {
      agent: DshAgentLike;
      turn: number;
      signal: AbortSignal;
    }): Promise<void> | void;

    /** 工具执行完成后的 waterfall 钩子。 */
    "tools/post-execute"(
      exec: {
        name: string;
        arguments?: Record<string, unknown>;
        agent?: DshAgentLike;
        [key: string]: unknown;
      },
      result: Readonly<unknown>,
      next: () => Promise<unknown>,
    ): Promise<unknown>;
  }
}

/** DSH Agent 的最小结构面（只用本 port 需要的方法）。 */
export interface DshAgentLike {
  id: string;
  session?: { id: string };
  steer?(message: DshMessageLike): void;
  inject?(message: DshMessageLike): void;
  followup?(message: DshMessageLike): void;
}

/** DSH Message 的最小结构面。 */
export interface DshMessageLike {
  role: "user" | "assistant" | "system";
  content: readonly { type: string; text?: string }[];
  source?: { kind?: string; plugin?: string; form?: string };
}

export {};
