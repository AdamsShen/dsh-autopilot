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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minimalInit } from "./minimal-init.js";
/** 被认为是「真实项目」的标志文件/目录。 */
const PROJECT_MARKERS = [
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "Gemfile",
    "composer.json",
    ".git",
    "src",
    "lib",
    "app",
];
/** 绝不在此类目录下凭空初始化。 */
const UNSAFE_ROOTS = ["/", "/tmp", "/var", "/usr", "/etc", "/home"];
function isUnsafeRoot(dir) {
    const resolved = path.resolve(dir);
    if (UNSAFE_ROOTS.includes(resolved)) {
        return true;
    }
    // 家目录本身也不该被当作项目根
    const home = process.env.HOME;
    if (home && resolved === path.resolve(home))
        return true;
    return false;
}
function looksLikeProject(dir) {
    for (const marker of PROJECT_MARKERS) {
        try {
            if (fs.existsSync(path.join(dir, marker)))
                return true;
        }
        catch {
            /* ignore */
        }
    }
    return false;
}
/**
 * 从起点向上找 git 仓库根。找到返回根，找不到返回 null。
 * 只认 `.git` 目录或 `.git` 文件（worktree 的情况）。
 */
export function findGitRoot(start) {
    let dir;
    try {
        dir = path.resolve(start);
    }
    catch {
        return null;
    }
    for (let depth = 0; depth < 64; depth += 1) {
        try {
            const gitEntry = path.join(dir, ".git");
            const st = fs.statSync(gitEntry, { throwIfNoEntry: false });
            if (st)
                return dir;
        }
        catch {
            /* keep walking */
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
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
export function resolveAutoInitRoot(opts) {
    const configured = opts.configuredRoot?.trim();
    if (configured) {
        if (isUnsafeRoot(configured)) {
            return { root: null, reason: "configured root is an unsafe location" };
        }
        if (!looksLikeProject(configured)) {
            return {
                root: null,
                reason: "configured root does not look like a project",
            };
        }
        return { root: path.resolve(configured), reason: "explicit projectRoot" };
    }
    const cwd = opts.cwd?.trim();
    if (!cwd)
        return { root: null, reason: "no cwd available" };
    const gitRoot = findGitRoot(cwd);
    if (gitRoot) {
        if (isUnsafeRoot(gitRoot)) {
            return { root: null, reason: "git root is an unsafe location" };
        }
        return { root: gitRoot, reason: "git repository root" };
    }
    if (isUnsafeRoot(cwd)) {
        return { root: null, reason: "cwd is an unsafe location" };
    }
    if (!looksLikeProject(cwd)) {
        return { root: null, reason: "cwd does not look like a project" };
    }
    return { root: path.resolve(cwd), reason: "cwd (project-like)" };
}
/** 已有 `.autopilot/config.yml` 视为已初始化。 */
export function isAlreadyInitialized(projectRoot) {
    try {
        const configPath = path.join(projectRoot, ".autopilot", "config.yml");
        const st = fs.statSync(configPath, { throwIfNoEntry: false });
        return Boolean(st?.isFile());
    }
    catch {
        return false;
    }
}
/**
 * 尝试动态加载 CLI 的 `installInitYes`。
 * 加载不到返回 null —— 这是正常情况（DSH profile 只装了 port 包）。
 */
async function loadInitYes(projectRoot) {
    // 解析顺序（MVP 足够，且都在失败时静默）：
    //   1. 显式环境变量 DSH_AUTOPILOT_CLI_PATH 指向 CLI 包入口
    //   2. 从**项目根**用 createRequire 解析（消费方项目自己装了 CLI 就是这条）
    //   3. 从 port 包自身位置解析（workspace / 开发态）
    // ESM 的 import() 按调用方模块位置解析，所以必须显式给 base。
    const fromSpecifier = async (specifier) => {
        try {
            const mod = (await import(specifier));
            return typeof mod.installInitYes === "function" ? mod.installInitYes : null;
        }
        catch {
            return null;
        }
    };
    const explicit = process.env.DSH_AUTOPILOT_CLI_PATH?.trim();
    if (explicit) {
        const loaded = await fromSpecifier(pathToFileUrl(explicit));
        if (loaded)
            return loaded;
    }
    // 候选根目录（按优先级）：
    //   1. 项目根（消费方项目自己装了 CLI）
    //   2. **插件自身位置向上**——link/workspace 安装时，port 包与 CLI 在同一个
    //      monorepo 里；DSH 从全局 profile 加载插件时，用户的项目根通常没有 CLI。
    //      这是最常见的真实场景，缺了这条会一直报 CLI not resolvable。
    const roots = [];
    if (projectRoot)
        roots.push(projectRoot);
    for (const selfRoot of selfAncestors()) {
        if (!roots.includes(selfRoot))
            roots.push(selfRoot);
    }
    // 全局安装的 CLI（npm i -g @autopilot-harness/cli）：这些目录本身就是
    // node_modules，不能再拼一层。插件独立发包后通常不在 monorepo 内，
    // 这条路径是最省事的使用方式。
    const globalNodeModules = globalRoots();
    {
        // 注意：不能用 createRequire().resolve() —— CLI 包的 exports 只声明了
        // `import` 条件，没有 `require`，require 解析会报
        // `No "exports" main defined`。这里直接按 node_modules 布局找入口。
        const candidates = [];
        for (const base of roots) {
            candidates.push(path.join(base, "node_modules/@autopilot-harness/cli/dist/index.js"), path.join(base, "node_modules/.pnpm/node_modules/@autopilot-harness/cli/dist/index.js"), 
            // 直接是 monorepo 源码树时（本仓库开发态）
            path.join(base, "packages/cli/dist/index.js"), path.join(base, "../packages/cli/dist/index.js"));
        }
        for (const nm of globalNodeModules) {
            candidates.push(path.join(nm, "@autopilot-harness/cli/dist/index.js"));
        }
        for (const candidate of candidates) {
            try {
                if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile())
                    continue;
            }
            catch {
                continue;
            }
            const loaded = await fromSpecifier(pathToFileUrl(candidate));
            if (loaded)
                return loaded;
        }
    }
    return fromSpecifier("@autopilot-harness/cli");
}
/**
 * 从本模块所在位置向上列举候选目录，最多 8 层。
 * 用途：port 包被 link 进全局 profile 时，CLI 往往在同级 node_modules
 * 或 monorepo 的 packages/ 下，而不是用户的项目目录里。
 */
function selfAncestors() {
    const out = [];
    try {
        // 本文件位于 packages/ports/dsh/dist/auto-init.js
        let dir = path.dirname(fileURLToPath(import.meta.url));
        for (let i = 0; i < 8; i += 1) {
            out.push(dir);
            const parent = path.dirname(dir);
            if (parent === dir)
                break;
            dir = parent;
        }
    }
    catch {
        /* ignore */
    }
    return out;
}
/**
 * 列举「本身就是 node_modules 的目录」，可直接拼 `@autopilot-harness/cli/...`。
 * 覆盖 npm / pnpm 的全局位置，以及 DSH profile 目录
 * （插件常以 link 装进 profile，CLI 也可能装在 profile 的依赖里）。
 */
function globalRoots() {
    const out = [];
    const push = (dir) => {
        if (typeof dir !== "string" || !dir.trim())
            return;
        const resolved = path.resolve(dir.trim());
        if (!out.includes(resolved))
            out.push(resolved);
    };
    // 优先尊重显式前缀
    push(process.env.npm_config_prefix);
    push(process.env.NPM_CONFIG_PREFIX);
    push(process.env.PNPM_HOME);
    push(process.env.DSH_HOME ? path.join(process.env.DSH_HOME, "profiles") : null);
    // 常见的全局前缀（无需 spawn 子进程，避免启动开销）
    const home = process.env.HOME;
    if (home) {
        push(path.join(home, ".npm-global/lib/node_modules"));
        push(path.join(home, ".local/share/pnpm/global/5/node_modules"));
        push(path.join(home, ".dsh/profiles"));
    }
    push("/usr/local/lib/node_modules");
    push("/opt/homebrew/lib/node_modules");
    return out;
}
/** 把绝对路径转成 import() 能吃的 file URL。 */
function pathToFileUrl(p) {
    const resolved = path.resolve(p);
    return `file://${resolved.split(path.sep).map(encodeURIComponent).join("/")}`;
}
/**
 * 执行自动初始化（幂等、fail-open）。
 *
 * @param opts.configuredRoot 插件配置里的 projectRoot（可为空）
 * @param opts.cwd DSH 进程工作目录
 * @param opts.locale 写入 config.yml 的 locale
 * @param opts.deps 可选注入，测试用（避免真的去 import CLI 包）
 */
export async function autoInitProject(opts) {
    const { root, reason } = resolveAutoInitRoot({
        configuredRoot: opts.configuredRoot,
        cwd: opts.cwd,
    });
    if (!root) {
        return { performed: false, projectRoot: null, reason, written: [] };
    }
    if (isAlreadyInitialized(root)) {
        return {
            performed: false,
            projectRoot: root,
            reason: "already initialized",
            written: [],
        };
    }
    const loader = opts.deps?.loadInitYes ?? (() => loadInitYes(root));
    const initYes = await loader();
    if (!initYes) {
        // 降级：写本端口真正需要的最小集合（不含 vendor runtime / 迁移）。
        if (opts.allowMinimalFallback !== false) {
            const minimal = minimalInit(root, opts.locale === "zh-CN" ? "zh-CN" : "en");
            if (minimal.performed) {
                return {
                    performed: true,
                    projectRoot: root,
                    reason: "minimal local init (autopilot CLI not installed)",
                    written: minimal.written,
                };
            }
            return {
                performed: false,
                projectRoot: root,
                reason: `autopilot CLI not resolvable and minimal init failed: ${minimal.reason}`,
                written: minimal.written,
            };
        }
        return {
            performed: false,
            projectRoot: root,
            reason: "autopilot CLI not resolvable from this profile",
            written: [],
        };
    }
    try {
        const result = initYes({
            projectRoot: root,
            platform: "dsh",
            surface: "cli",
            platforms: [{ id: "dsh", surface: "cli" }],
            locale: opts.locale === "zh-CN" ? "zh-CN" : "en",
            force: false,
            writeQuickstart: true,
        });
        if (!result.ok) {
            return {
                performed: false,
                projectRoot: root,
                reason: `init failed: ${result.error ?? "unknown"}`,
                written: [],
            };
        }
        return {
            performed: true,
            projectRoot: root,
            reason: "initialized",
            written: result.written ?? [],
        };
    }
    catch (err) {
        return {
            performed: false,
            projectRoot: root,
            reason: `init threw: ${err instanceof Error ? err.message : String(err)}`,
            written: [],
        };
    }
}
//# sourceMappingURL=auto-init.js.map