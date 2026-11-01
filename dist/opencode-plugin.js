import { spawn } from 'node:child_process';
const DEFAULT_COMMAND = 'episodic-memory';
const DEFAULT_SUMMARY_LIMIT = 10;
function optionString(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}
function optionPositiveInteger(value, fallback) {
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
export function buildSyncArgs(summaryLimit) {
    return ['sync', '--background', '--only', 'opencode', '--summary-limit', String(summaryLimit)];
}
// Run the sync command in the background via a shell, mirroring V1's Bun `$`.
// The child's own file lock (#97) and reentrancy guard (#87) guarantee that a
// second concurrent sync is skipped rather than duplicated. Logging is
// best-effort here; the background sync also logs to its own sync log file.
async function runSync(command, args) {
    await new Promise((resolve) => {
        const child = spawn(command, args, { shell: true });
        const finish = (code) => {
            if (code === 0) {
                console.log('episodic-memory: started opencode conversation sync');
            }
            else {
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
async function consumeEvents(iterator, command, args) {
    try {
        for (;;) {
            const { done, value } = await iterator.next();
            if (done)
                break;
            if (value.type !== 'session.idle')
                continue;
            await runSync(command, args);
        }
    }
    catch {
        // Best-effort: ignore stream errors / cancellation.
    }
}
export async function setup(ctx) {
    const command = optionString(ctx?.options?.command, DEFAULT_COMMAND);
    const summaryLimit = optionPositiveInteger(ctx?.options?.summaryLimit, DEFAULT_SUMMARY_LIMIT);
    const args = buildSyncArgs(summaryLimit);
    const subscribe = ctx?.event?.subscribe;
    if (typeof subscribe !== 'function') {
        return async () => { };
    }
    const iterator = subscribe({ types: ['session.idle'] })[Symbol.asyncIterator]();
    // Kick off the consumer without awaiting it, so a long-lived event stream
    // never blocks plugin setup. The host gets the cleanup immediately.
    void consumeEvents(iterator, command, args);
    return async () => {
        try {
            await iterator.return?.();
        }
        catch {
            // ignore
        }
    };
}
export default {
    id: 'episodic-memory',
    setup,
};
