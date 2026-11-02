# Plan: Port the OpenCode auto-sync plugin to OpenCode V2

Date: 2026-11-02
Status: ready to execute

## Context / Problem

The OpenCode server plugin at `C:\Dev\episodic-memory` fails to load under OpenCode **V2**
(`err_54c72a3f`):

> PluginModule.LoadError: Plugin must export a default definition with an id and an
> effect or setup function. (cause: SchemaError(Missing key at ["default"]["effect"],
> Missing key at ["default"]["setup"]))

The plugin's default export is still the **V1** shape `{ id, server }` (where `server`
returns a `{ event }` hook). OpenCode V2 requires `{ id, setup }` (or `{ id, effect }`)
and calls `plugin.setup(ctx)`.

## Phase 0 result (upstream check) — done

Upstream (`obra/episodic-memory`) has **no** V2 support:
- `origin/main` (local HEAD `7e06519`) still has the V1 shape `export default { id, server }`.
- No tag newer than `v1.6.0`; the two side branches (`fix-install`, `ci/add-github-actions`)
  are old/CI branches, not a V2 port.
- The package is **not on npm** (registry 404) — distributed only via GitHub.

**Conclusion:** proceed with Option B — port only the auto-sync plugin to V2.

## Scope (in / out)

In:
- Rewrite `src/opencode-plugin.ts` to the V2 `Plugin` shape.
- Update `test/opencode-plugin.test.ts` to cover the V2 behavior (TDD).
- Rebuild (`npm run build`) and verify.
- Local commit (no push, no publish).

Out (do NOT touch):
- The MCP server (`mcp.servers.episodic-memory` → `cli/mcp-server`) — unchanged.
- `sync-cli.ts`, file lock, reentrancy guard — unchanged (they already prevent duplicate syncs).
- The Codex plugin / any other feature.

## V2 API facts (verified against `@opencode/plugin@2.2.5`)

1. `define(plugin) { return plugin; }` — pure identity. The loader only checks that the
   default export has `id` + (`setup` | `effect`) and then calls `plugin.setup(ctx)`.
   ⇒ We can export a **plain** `{ id, setup }` object **without importing `@opencode/plugin`**,
   keeping the package dependency-free (matching its original self-contained design).
2. The host calls `setup(ctx)` where `ctx` has:
   - `ctx.options` — the plugin's config `options` (a `Record<string, any>`).
   - `ctx.event.subscribe({ types?: string[] })` — returns an `AsyncIterable` of events
     (adapter.js:230 passes `types` through for server-side filtering).
   - `ctx.shell` — **hooks-only** (no exec), so command execution must use `node:child_process`.
   - `ctx.app` — only `{ name, version, channel }`; **no** `app.log` (V1 had `client.app.log`).
   The value returned by `setup` is used as the cleanup function (adapter.js:482
   `Effect.acquireRelease`).
3. `session.idle` **is** a valid V2 event type (`OpenCodeEvent["type"]` includes it).
4. `episodic-memory` is on PATH (npm global `episodic-memory.cmd`); the CLI routes
   `sync` → `dist/sync-cli.js`; `--background` spawns a detached child and exits 0, and the
   single-instance file lock (#97) plus the reentrancy guard (#87) already prevent duplicate
   concurrent syncs. So duplicate-process safety is preserved without any CLI changes.

## Design decisions

1. **Dependency-free V2 plugin.** Export `{ id: 'episodic-memory', setup }`. No
   `@opencode/plugin` import. Use a minimal local type for the `ctx` slice we use
   (`options`, `event.subscribe`).
2. **Run sync via `child_process.spawn(command, args, { shell: true })`.** This faithfully
   mirrors V1's shell-based `$` and, on Windows, resolves the `episodic-memory.cmd` shim via
   PATH. `command` defaults to `episodic-memory`; overridable via `ctx.options.command`.
   `args` = `['sync', '--background', '--only', 'opencode', '--summary-limit', <n>]`
   (same as V1).
3. **Subscribe to `session.idle`** with a server-side `types` filter **and** a defensive
   `event.type === 'session.idle'` guard (mirrors V1). On each idle event, run the sync.
4. **Logging via `console`** (V2 has no `app.log`). Info on success, warn on non-zero exit.
   The background sync also logs to its own sync log file.
5. **Cleanup** returns a function that cancels the event iterator on plugin teardown
   (`iterator.return()`), guarded so it never throws.
6. **Duplicate safety** is preserved by the existing `sync-cli.ts` file lock — no changes there.

## Tasks (TDD order)

1. **RED** — Rewrite `test/opencode-plugin.test.ts` for V2:
   - default export is `{ id: 'episodic-memory', setup }` (directly guards the original bug);
   - on a `session.idle` event, `setup` spawns `episodic-memory sync --background --only
     opencode --summary-limit N` (mock `node:child_process`);
   - non-idle events do not trigger a spawn;
   - `ctx.options.command` / `ctx.options.summaryLimit` are honored (default 10);
   - `buildSyncArgs` produces the exact arg list;
   - package metadata still exposes `./server` → `dist/opencode-plugin.js`;
   - `docs/OPENCODE.md` still exists.
   Run `npx vitest run test/opencode-plugin.test.ts` → **must FAIL** against current V1 code.
2. **GREEN** — Rewrite `src/opencode-plugin.ts` to the V2 design above. Re-run → **must PASS**.
3. **Full suite** — `npm test` (vitest) → no regressions in other tests.
4. **Build** — `npm run build` (tsc + bundle; regenerates `dist/opencode-plugin.{js,d.ts}`;
   re-bundles `dist/mcp-server.js` canonically). Confirm `dist/opencode-plugin.js` is V2-shaped.
5. **Verify no-duplicate sync** — run `episodic-memory sync --background --only opencode
   --summary-limit 10` twice concurrently; the second must report "sync already running"
   (file lock) and exit 0.
6. **Verify plugin loads** — `node -e "import('.../dist/opencode-plugin.js').then(m => console.log(m.default.id, typeof m.default.setup))"`
   → prints `episodic-memory function`.
7. **Commit** (local only, no push) — stage only the four intended files:
   `src/opencode-plugin.ts`, `test/opencode-plugin.test.ts`,
   `dist/opencode-plugin.js`, `dist/opencode-plugin.d.ts`.
   Do NOT stage the pre-existing `dist/mcp-server.js` rebuild or autocrlf churn.
   (Repo uses `core.autocrlf=true`, so line endings normalize to LF in the commit.)

## Rollback

If anything breaks: `git checkout -- <files>` to restore the pre-change state, or reset the
local commit (`git reset --soft HEAD~1` then unstage). Nothing is published.
