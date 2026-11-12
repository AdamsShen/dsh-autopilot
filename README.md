# Autopilot Harness for DeepSeek Harness (DSH)

Structured **planning → checklist execution → multi-lens self-review** inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), as an in-process DSH plugin.

[中文](./README.zh-CN.md)

> Part of the [Autopilot Harness](https://github.com/mt2007/autopilot-harness) family. Core engine: [`@autopilot-harness/core`](https://www.npmjs.com/package/@autopilot-harness/core).

---

## What it does

Autopilot intercepts DSH's turn boundary (`agent/turn-stopping`). After the agent edits product code, instead of stopping and waiting for you, it injects a follow-up and keeps going through five rotating review lenses. When the checklist item is clean, it advances — local commit, no auto-push.

```
/autopilot-on  →  grill rounds  →  brief / plan / checklist
       ↓
/autopilot-run →  per item: implement → fix → confirm×N → advance
       ↓
done (checklist clear)
```

| Lens | Round |
|---|---:|
| Correctness & invariants | 1 |
| Nulls, boundaries & error paths | 2 |
| Concurrency, races & partial failure | 3 |
| Security & trust boundaries | 4 |
| Test gaps & regression (read-only) | 5 |

---

## Install

**From npm** (appears in the DSH plugin center):

```bash
dsh plugin --profile web add dsh-autopilot
```

**From source** (works even before an npm release):

```bash
dsh plugin --profile web add github:<owner>/dsh-autopilot
```

`dist/` is committed, so the source install needs no build step.

`plugin add` only installs the dependency. It does **not** append the bundle entry — add it by hand in `~/.dsh/profiles/<profile>/package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-autopilot"
      ]
    }
  }
}
```

Verify composition:

```bash
dsh --profile <profile> --dump-config | grep autopilot-harness
```

Then **fully restart DSH**.

> Installing the plugin creates **no project files**. Enabling is explicit — see below.

---

## Enable a project

Inside a session for the project you want to instrument:

```
/autopilot-enable
```

If `@autopilot-harness/cli` is installed (globally or in the project), this runs the full `init`. If it is not, the plugin performs a **minimal local init** instead — so `/autopilot-enable` works out of the box.

| | Full init (CLI present) | Minimal init (CLI absent) |
|---|---|---|
| `.autopilot/config.yml` | ✅ | ✅ |
| `.autopilotignore` | ✅ | ✅ |
| `docs/autopilot/{plans,specs}` | ✅ | ✅ |
| `docs/autopilot/workflows`, `quickstart.md` | ✅ | — |
| `.autopilot/bin/` (vendor runtime + migrations) | ✅ | — (unused by DSH) |

`state.db` is created lazily on first real use either way.

Full `init` tree:

```
<project>/.autopilot/
├── config.yml      settings
├── state.db        SQLite: sessions, review chains, checklist progress
├── pin.json        version anchor
└── bin/            hook runtime + migrations
<project>/docs/autopilot/
├── plans/          brief.md / plan.md / checklist.md
├── specs/          cross-track behaviour specs
└── workflows/      planning + executing guidance
```

Until `.autopilot/config.yml` exists, every Autopilot hook is a no-op for that project. A stray `state.db` alone does **not** count as enabled.

---

## Commands

| Command | Effect |
|---|---|
| `/autopilot-enable` | Run init for the current project (**only** command that writes to disk) |
| `/autopilot-on [slug · brief]` | Enter planning; grill rounds produce brief/plan/checklist |
| `/autopilot-run` | Execute the checklist item by item |
| `/autopilot-off` | Pause |
| `/autopilot-replan` | Revise the plan |
| `/autopilot-resume` | Resume execution |

Text triggers work too, matched at line start: `Autopilot ON`, `Autopilot RUN`, `Autopilot OFF`, `Autopilot RESUME`, `Autopilot REPLAN`, `开启自动驾驶`, `开始执行`, …

`/autopilot-on` argument rules:

- a single slug-shaped token → track name: `/autopilot-on user-login`
- anything else → treated as the brief; the slug is generated later
- both → separate with `·` (middle dot): `/autopilot-on user-login · add phone login`

---

## Configuration

Project-level, in `<project>/.autopilot/config.yml` (takes effect on the next operation, no restart):

```yaml
review:
  scope: project        # project = any product-code edit; executing_only = only during RUN
  confirm_rounds: 5     # 5 = full lens set; 3 = light (lenses 1→2→5)
  verify:
    enabled: false      # run test commands and record the result
  stuck:
    max_idle_stops: 5
  errors:
    max_before_pause: 0 # 0 = never pause on errors
    recover: true
```

Plugin-level, in the profile's bundle entry:

| Option | Default | Meaning |
|---|---|---|
| `autoInit` | `false` | Initialise automatically. Keep `false`; prefer `/autopilot-enable`. |
| `maxSteerPerTurn` | `32` | Max continuations per turn (loop guard). |
| `projectRoot` | *(empty)* | Pin the project root. Normally leave empty — the project is resolved from the session's own working directory. |

---

## How it differs from other Autopilot ports

Every other host blocks its stop event with a decision object. DSH has no such decision: `agent/turn-stopping` is a **serial** hook, and continuation is a data side effect.

```ts
// this port's stop result — not { decision, reason }
interface DshStopResult { steerMessage?: string }
```

The plugin calls `agent.steer(message)`; DSH's loop re-reads its inbox and runs another step. DSH publishes no stop-continue cap, so this port does **not** clamp `review.confirm_rounds`.

Two consequences worth knowing:

- `turn-stopping` fires **multiple times per turn** with an unchanged turn number — rounds are tracked internally, never derived from `payload.turn`.
- There is **no `hooks.json`**. Hooks are registered in code via `ctx.on(...)` inside `apply(ctx)`; `cordis.patch.yml` only makes DSH load the plugin.

---

## Project boundary

DSH installs plugins globally, so one host process serves sessions from many projects. `process.cwd()` is the *host* directory, not the project. This port resolves the project from the session's own working directory (`session.header.cwd`) and caches state per project root — two sessions in two projects get two independent `.autopilot/` trees.

---

## Compatibility and permissions

| | |
|---|---|
| **Capability category** | Workflow & automation (`工作流与自动化`) |
| **DSH target** | `>=0.2.1-rc.2 <0.3.0` (declared as `engines.dsh`) |
| **Platforms** | macOS / Windows / Linux — pure Node.js, no native code |
| **Profiles** | Any DSH profile; examples use `web` |
| **Network** | None. The plugin makes no outbound requests. |
| **Filesystem** | Writes only inside an explicitly enabled project: `.autopilot/`, `docs/autopilot/`, `.autopilotignore`. Never writes before `/autopilot-enable`. |
| **Credentials** | None. No API keys, no tokens. |
| **External services** | None |

## Requirements

- Node.js ≥ 22
- DSH ≥ 0.2.1-rc.2 (< 0.3.0)
- Optional: `@autopilot-harness/cli` for the full `init` tree (vendor runtime, migrations, workflow docs). Without it, `/autopilot-enable` falls back to a **minimal local init** that writes only what DSH uses.

---

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run check          # typecheck + build + test + npm pack --dry-run
```

### Layout

| File | Role |
|---|---|
| `src/index.ts` | Pure adapters — no `@deepseek-ai/*` imports, fully unit-testable |
| `src/plugin.ts` | DSH plugin entry (`name` / `Config` / `apply`); only file touching DSH types, via `import type` |
| `src/auto-init.ts` | Optional auto-initialisation with safety guards |
| `src/dsh-events.d.ts` | Minimal local event contracts so DSH stays an optional peer |
| `cordis.patch.yml` | Loader entry DSH composes into the profile |

---

## Publishing

```bash
npm run check
npm publish            # prepack runs the build
```

`files` ships `dist/`, `cordis.patch.yml`, `assets/`, and the READMEs.

---

## License

MIT — see [LICENSE](./LICENSE).