# Notes for agents working in this repo

Read this before running anything. It exists because `codex exec review` cannot be re-prompted
(`--base` refuses a prompt argument), so this file is the only steering a reviewer gets.

## What this is

A Node/TypeScript background daemon bridging the Claude Code CLI to Telegram, so Claude Code sessions
can be driven from a phone. One "manager bot" adds/removes/lists bots; N "worker bots" are each bound
to a project directory and run Claude Code via the `@anthropic-ai/claude-code` SDK's `query()` in that
cwd, streaming results back. Extras: tool-approval inline keyboards, ngrok tunnels, and
natural-language cron scheduling.

## Running things

- Install: `npm install` (CI uses `npm ci`). Dev: `npm run dev` (`tsx src/cli.ts`).
- Lint: `npm run lint` (`eslint .`). Format check: `npm run format:check`.
- **`prettier --check .` includes markdown**, so this file and the README are CI-gated like the code.
  It rewrites `*em*` to `_em_` and will dedent a list item whose wrapped line starts a code span, so
  keep an inline `` `code` `` on one line. Run `npx prettier --write` on any doc you edit.
- Typecheck: `npm run typecheck` (`tsc --noEmit -p tsconfig.typecheck.json`).
- Test: `npm test` (`vitest run --passWithNoTests`).
- **There is a build step**: `npm run build` (`tsc` → `dist/`). `bin.claude-telegram` points at
  `dist/cli.js`, so the published entry point only exists after a build. `npm start` runs the built
  output.
- CI runs: `npm ci` → lint → format:check → typecheck → build → test. Node 22 in CI; `engines.node`
  is `>=18`.

## Things that look like bugs and are not

- **Two tsconfigs, on purpose.** `tsconfig.json` includes only `src/**/*` so emit stays clean;
  `tsconfig.typecheck.json` extends it with `noEmit` and adds `tests/` and `vitest.config.ts`. Not
  redundant — do not consolidate them.
- **`.js` import specifiers in `.ts` source** (`from "./formatter.js"`) are correct under NodeNext
  ESM resolution. Not a mistake.
- **Config file deliberately beats env vars.** `src/config.ts` resolves `file.X ?? process.env.X`
  because a stale shell-profile value would otherwise override what the setup wizard wrote. Reviewers
  routinely flag this as inverted precedence; it is intentional and commented.
- **`config.ts` calls `process.exit(1)` at module load** when token/owner are missing. Deliberate
  fail-fast for a CLI, but it does mean importing the module has side effects.
- **Deliberate env scrubbing** in the `ClaudeSession` constructor: it strips `CLAUDECODE` /
  `CLAUDE_CODE` (the SDK refuses to run nested inside Claude Code) and strips an inherited
  `ANTHROPIC_API_KEY`, re-injecting only from its own config. Removing either "cleanup" breaks it.
- **`src/formatter.ts` uses `\x00PH<n>\x00` sentinels** and a module-level counter reset at the top of
  `claudeToTelegram()`. That is a deliberate multi-phase markdown→Telegram-HTML pipeline (stash code
  blocks → block elements → inline code → escape → restore). The counter is reset per call, so it is
  not a leak — though it is not concurrency-safe, which is worth knowing before anything calls it in
  parallel.
- **`src/log.ts` has two output modes** — ANSI colours when `stdout.isTTY`, JSON lines otherwise for
  the daemon log. Both branches are intended.
- **`drop_pending_updates: true`** on daemon start deliberately discards Telegram messages queued
  while it was down.
- **`@ngrok/ngrok` is an optionalDependency**, so `src/tunnel.ts` must tolerate its absence.
- ESLint disables `no-explicit-any` and allows `_`-prefixed unused vars, so `any` and `_options` are
  sanctioned here.

## Invariants worth knowing before judging a change

- **The owner-ID equality check is the entire authorization model.** A grammy middleware comparing
  `ctx.from?.id` to the configured owner is the only thing between a stranger and arbitrary code
  execution in a project directory. Any change that weakens, reorders or bypasses that check is the
  single highest-severity defect possible in this repo — treat it that way.
- **Auto-approval is the documented product behaviour, not a slip.**
  `permissionMode: "bypassPermissions"` appears as a default argument in several call sites; the
  interactive path is the `canUseTool` callback resolving against a Telegram inline keyboard. Note
  that `canUseTool` falls through to _allow_ when no approval callback is wired — worth flagging if
  a new caller forgets to pass one.
- **Secrets live outside the repo** in `~/.clautel/`, with the directory created `0o700` and files
  written `0o600`. A change that widens those modes or moves state into the repo is a regression.
- **Worker-bot tokens arrive in a chat message** (`/add <token> <path>`), so they transit Telegram and
  persist in message history. That is inherent to the design; what matters on review is that nothing
  _logs_ them. The logging helpers take free-form strings, so any new log line interpolating a token
  or config object would leak it to `~/.clautel/app.log`.
- The `workingDir` from `/add` does not appear to be path-validated. Worth flagging on any change
  near it.

## Where the risk actually is

One test file (`tests/formatter.test.ts`, 5 cases) covers message splitting and formatting. The two
largest modules — `src/worker.ts` (~900 lines) and `src/claude.ts` (~640) — have **zero** coverage,
and that is where the authorization and session logic lives. `--passWithNoTests` is intentional
scaffolding for a suite that does not exist yet; deleting the one test file would still pass CI.

Weight review attention toward: the owner check and anything touching it, tool-approval flow,
credential handling and logging, and session/process lifecycle.
