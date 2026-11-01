import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import plugin, { buildSyncArgs, setup } from '../src/opencode-plugin.js';
import { spawn } from 'node:child_process';

vi.mock('node:child_process');

const REPO_ROOT = join(import.meta.dirname, '..');
const spawnMock = vi.mocked(spawn);

function readJson(relPath: string): any {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), 'utf-8'));
}

// A fake spawned child that immediately reports exit code `code`.
function fakeChild(code: number) {
  return {
    on: (event: string, cb: (c?: number) => void) => {
      if (event === 'exit') cb(code);
    },
    unref: () => {},
  } as any;
}

// Build an async iterable of events, plus a promise that resolves once the
// consumer has drained it (reached `done`) or cancelled it (via `return()`).
function eventSource(items: Array<{ type: string }>) {
  let i = 0;
  let resolveCompleted: () => void = () => {};
  const completed = new Promise<void>((res) => (resolveCompleted = res));
  const iterator = {
    next: async () => {
      if (i < items.length) {
        return { done: false, value: items[i++] };
      }
      resolveCompleted();
      return { done: true, value: undefined };
    },
    return: async () => {
      resolveCompleted();
      return { done: true, value: undefined };
    },
  };
  return { [Symbol.asyncIterator]: () => iterator, completed } as any;
}

function mockCtx(events: Array<{ type: string }>, options: Record<string, unknown> = {}) {
  const iterable = eventSource(events);
  return {
    options,
    event: { subscribe: () => iterable },
  } as any;
}

// Await the consumer finishing, with a timeout so a stuck stream fails fast.
async function awaitCompleted(iterable: { completed: Promise<void> }, ms = 5000): Promise<void> {
  await Promise.race([
    iterable.completed,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('event stream did not complete')), ms),
    ),
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  spawnMock.mockImplementation(() => fakeChild(0));
});

describe('opencode plugin packaging', () => {
  it('exports a V2 opencode plugin as the default export', () => {
    expect(plugin.id).toBe('episodic-memory');
    expect(typeof plugin.setup).toBe('function');
    expect(plugin).toMatchObject({ id: 'episodic-memory', setup });
    // The V1 `server` export must be gone.
    expect((plugin as any).server).toBeUndefined();
  });

  it('runs opencode-only background sync when a session becomes idle', async () => {
    const ctx = mockCtx([{ type: 'session.idle' }, { type: 'session.created' }]);
    const cleanup = await setup(ctx);
    await awaitCompleted(ctx.event.subscribe());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'episodic-memory',
      ['sync', '--background', '--only', 'opencode', '--summary-limit', '10'],
      { shell: true },
    );
    await cleanup();
  });

  it('does not sync for non-idle events', async () => {
    const ctx = mockCtx([{ type: 'session.created' }, { type: 'session.text.delta' }]);
    const cleanup = await setup(ctx);
    await awaitCompleted(ctx.event.subscribe());

    expect(spawnMock).not.toHaveBeenCalled();
    await cleanup();
  });

  it('honors command and summaryLimit options', async () => {
    const ctx = mockCtx([{ type: 'session.idle' }], { command: 'custom-cli', summaryLimit: 5 });
    const cleanup = await setup(ctx);
    await awaitCompleted(ctx.event.subscribe());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'custom-cli',
      ['sync', '--background', '--only', 'opencode', '--summary-limit', '5'],
      { shell: true },
    );
    await cleanup();
  });

  it('builds the exact sync argument list', () => {
    expect(buildSyncArgs(10)).toEqual(['sync', '--background', '--only', 'opencode', '--summary-limit', '10']);
    expect(buildSyncArgs(3)).toEqual(['sync', '--background', '--only', 'opencode', '--summary-limit', '3']);
  });

  it('declares an opencode server export in package metadata', () => {
    const pkg = readJson('package.json');

    expect(pkg.exports['./server']).toBeDefined();
    expect(pkg.exports['./server'].import).toBe('./dist/opencode-plugin.js');
  });

  it('builds an opencode documentation page', () => {
    expect(existsSync(join(REPO_ROOT, 'docs/OPENCODE.md'))).toBe(true);
  });
});
