import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportOpencodeSessions, getOpencodeTranscriptFilePath } from '../src/opencode-sync.js';
import { parseConversation } from '../src/parser.js';

describe('OpenCode 2.2.5 export', () => {
  let dir: string;
  let db: Database.Database;
  let dbPath: string;
  let transcriptDir: string;
  const output = (id = 'ses_v2') => getOpencodeTranscriptFilePath(transcriptDir, { sessionId: id, directory: '/work/v2' });
  const run = () => exportOpencodeSessions({ dbPath, transcriptDir });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'episodic-v2-'));
    dbPath = join(dir, 'opencode.db');
    transcriptDir = join(dir, 'transcripts');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT);
      INSERT INTO project VALUES ('p', 'v2', '/work/v2');
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
      INSERT INTO session_v2 VALUES ('ses_v2', NULL, 'p', 'slug', '/work/v2', 'V2', '2.2.5', 'planner', NULL, 1700000000000, 1700000000000);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE session_part (message_id TEXT, session_id TEXT, ordinal INTEGER, type TEXT, call_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, PRIMARY KEY(message_id,ordinal));
    `);
    const message = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)');
    // Identical timestamps and reversed IDs deliberately require seq ordering.
    message.run('z_user', 'ses_v2', 'user', 1, 1700000000000, 1700000000000, JSON.stringify({ text: 'Remember the V2 export contract.', files: [] }));
    message.run('a_assistant', 'ses_v2', 'assistant', 2, 1700000000000, 1700000000000, JSON.stringify({ model: { id: 'local', providerID: 'llama-local' } }));
    message.run('compact', 'ses_v2', 'compaction', 3, 1700000000000, 1700000000000, JSON.stringify({ status: 'completed', summary: 'A durable checkpoint' }));
    const part = db.prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    part.run('a_assistant', 'ses_v2', 1, 'text', null, 1700000000000, 1700000000000, JSON.stringify({ type: 'text', text: 'Archived V2 answer.' }));
    part.run('a_assistant', 'ses_v2', 0, 'tool', 'call_1', 1700000000000, 1700000000000, JSON.stringify({ type: 'tool', id: 'call_1', name: 'read', state: { status: 'completed', input: { path: 'x' }, content: [{ type: 'text', text: 'tool evidence' }] } }));
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('exports V2-only databases into parseable exchanges, preserving tools and compaction', async () => {
    expect(run()).toMatchObject({ exported: 1, errors: [] });
    const lines = readFileSync(output(), 'utf8').trim().split('\n').map(JSON.parse);
    expect(lines[0].storageVersion).toBe(2);
    expect(lines[1].message.role).toBe('user');
    expect(lines[2].parts.map((p: any) => p.type)).toEqual(['tool', 'text']);
    expect(lines[3].message).toMatchObject({ type: 'compaction', summary: 'A durable checkpoint' });
    expect(lines[3].message.role).toBeUndefined();
    const exchanges = await parseConversation(output(), 'v2', output());
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toMatchObject({ userMessage: 'Remember the V2 export contract.', assistantMessage: 'Archived V2 answer.', modelProvider: 'llama-local' });
    expect(exchanges[0].toolCalls?.[0]).toMatchObject({ id: 'call_1', toolName: 'read', isError: false });
    expect(exchanges[0].toolCalls?.[0].toolResult).toContain('tool evidence');
  });

  it('reads completed assistant content folded into message.data instead of part rows', async () => {
    db.exec('DELETE FROM session_part');
    db.prepare('UPDATE session_message SET data=? WHERE id=?').run(JSON.stringify({ content: [
      { type: 'text', text: 'Folded answer' },
      { type: 'tool', id: 'folded_call', name: 'read', state: { status: 'completed', content: [{ type: 'text', text: 'folded evidence' }] } },
    ] }), 'a_assistant');
    run();
    const exchanges = await parseConversation(output(), 'v2', output());
    expect(exchanges[0].assistantMessage).toBe('Folded answer');
    expect(exchanges[0].toolCalls?.[0].toolResult).toContain('folded evidence');
  });

  it('skips unchanged exports and refreshes part updates even when session time is unchanged', () => {
    expect(run().exported).toBe(1);
    expect(run()).toMatchObject({ exported: 0, skipped: 1, errors: [] });
    db.prepare('UPDATE session_part SET time_updated=?, data=? WHERE ordinal=1').run(1700000010000, JSON.stringify({ type: 'text', text: 'Updated answer' }));
    expect(run().exported).toBe(1);
    expect(readFileSync(output(), 'utf8')).toContain('Updated answer');
    expect(run().skipped).toBe(1);
  });

  it('preserves child sessions and marks their parsed exchanges as sidechains', async () => {
    db.exec("UPDATE session_v2 SET parent_id='ses_parent'");
    run();
    expect(JSON.parse(readFileSync(output(), 'utf8').split('\n')[0]).session.parentID).toBe('ses_parent');
    expect((await parseConversation(output(), 'v2', output()))[0].isSidechain).toBe(true);
  });

  it('supports coexistence, prefers V2 for migrated IDs, and upgrades older exports', () => {
    db.exec(`
      CREATE TABLE session AS SELECT id, project_id, slug, directory, title, version, agent, model, time_created, time_updated FROM session_v2;
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      INSERT INTO session SELECT 'ses_legacy', project_id, slug, directory, title, '1.0', agent, model, time_created, time_updated FROM session_v2;
    `);
    expect(run()).toMatchObject({ exported: 2, errors: [] });
    expect(run()).toMatchObject({ exported: 0, skipped: 2 });
    const original = readFileSync(output(), 'utf8');
    writeFileSync(output(), original.replace('"storageVersion":2,"exportVersion":1,', ''));
    expect(run()).toMatchObject({ exported: 1, skipped: 1, errors: [] });
    expect(readFileSync(output(), 'utf8')).toBe(original);
  });
});
