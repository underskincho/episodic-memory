import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// V2 OpenCode plugin (auto-sync on session idle).
//
// OpenCode V2 loads a plugin as a default export of shape
//   { id, setup }   (or { id, effect })
// and calls `plugin.setup(ctx)`. The value `setup` returns is used as the
// plugin's cleanup function (adapter.js -> Effect.acquireRelease).
//
// This plugin is intentionally dependency-free: it does NOT import
// `@opencode/plugin`. `Plugin.define()` is a pure identity function
// (`define(p) => p`), so a plain object is accepted by the loader. The only
// slice of the context we use is `ctx.options` (plugin config) and
// `ctx.event.subscribe({ types })` (server-side filtered event stream).
//
// V2 dropped V1's Bun `$` shell helper, and `ctx.shell` is hooks-only, so the
// sync command is run with `node:child_process`. On Windows the `shell: true`
// option resolves the `episodic-memory.cmd` npm shim via PATH, matching the
// original V1 shell invocation. The child process's own single-instance file
// lock (#97) and reentrancy guard (#87) prevent duplicate concurrent syncs.
// ---------------------------------------------------------------------------

interface EventLike {
  type?: string;
}

interface EventIterable {
  [Symbol.asyncIterator]: () => AsyncIterator<EventLike>;
}

interface PluginContext {
  options?: Record<string, unknown>;
  event?: {
    subscribe: (options?: { types?: string[] }) => EventIterable;
  };
}

type PluginCleanup = () => void | Promise<void>;

const DEFAULT_COMMAND = 'episodic-memory';
const DEFAULT_SUMMARY_LIMIT = 10;

function optionString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function optionPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

export function buildSyncArgs(summaryLimit: number): string[] {
  return ['sync', '--background', '--only', 'opencode', '--summary-limit', String(summaryLimit)];
}

// Run the sync command in the background via a shell, mirroring V1's Bun `$`.
// The child's own file lock (#97) and reentrancy guard (#87) guarantee that a
// second concurrent sync is skipped rather than duplicated. Logging is
// best-effort here; the background sync also logs to its own sync log file.
async function runSync(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(command, args, { shell: true });
    const finish = (code?: number | null) => {
      if (code === 0) {
        console.log('episodic-memory: started opencode conversation sync');
      } else {
        console.warn(`episodic-memory: opencode sync failed (exit ${code ?? 'unknown'})`);
      }
      resolve();
    };
    child.on('exit', (code) => finish(code));
    child.on('error', (err) => {
      console.warn(`episodic-memory: opencode sync error: ${err.message}`);
      resolve();
    });
  });
}

// Consume the (server-side filtered) event stream in the background. A broken
// or cancelled stream must not take the plugin down.
async function consumeEvents(iterator: AsyncIterator<EventLike>, command: string, args: string[]): Promise<void> {
  try {
    for (;;) {
      const { done, value } = await iterator.next();
      if (done) break;
      if (value.type !== 'session.idle') continue;
      await runSync(command, args);
    }
  } catch {
    // Best-effort: ignore stream errors / cancellation.
  }
}

export async function setup(ctx: PluginContext): Promise<PluginCleanup> {
  const command = optionString(ctx?.options?.command, DEFAULT_COMMAND);
  const summaryLimit = optionPositiveInteger(ctx?.options?.summaryLimit, DEFAULT_SUMMARY_LIMIT);
  const args = buildSyncArgs(summaryLimit);

  const subscribe = ctx?.event?.subscribe;
  if (typeof subscribe !== 'function') {
    return async () => {};
  }

  const iterator = subscribe({ types: ['session.idle'] })[Symbol.asyncIterator]();

  // Kick off the consumer without awaiting it, so a long-lived event stream
  // never blocks plugin setup. The host gets the cleanup immediately.
  void consumeEvents(iterator, command, args);

  return async () => {
    try {
      await iterator.return?.();
    } catch {
      // ignore
    }
  };
}

export default {
  id: 'episodic-memory',
  setup,
};
