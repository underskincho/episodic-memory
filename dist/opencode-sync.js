import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { getOpencodeDbPath, getOpencodeTranscriptDir } from './paths.js';
function safeParseJson(value) {
    if (!value)
        return undefined;
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
function safeSegment(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return 'unknown';
    return trimmed.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}
function projectNameFromDirectory(directory) {
    return safeSegment(path.basename(directory) || directory);
}
function dateFromMillis(value) {
    const millis = Number.isFinite(value) ? value : Date.now();
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? new Date() : date;
}
function tableExists(db, table) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    return Boolean(row);
}
export function getOpencodeTranscriptFilePath(transcriptDir, input) {
    const project = projectNameFromDirectory(input.directory);
    return path.join(transcriptDir, project, `opencode-${safeSegment(input.sessionId)}.jsonl`);
}
function shouldExportSession(filePath, sessionUpdatedMs, v2 = false) {
    if (!fs.existsSync(filePath))
        return true;
    if (v2) {
        // Refresh legacy exports of sessions migrated with the same ID/timestamp once.
        const fd = fs.openSync(filePath, 'r');
        try {
            const prefix = Buffer.alloc(80);
            const length = fs.readSync(fd, prefix, 0, prefix.length, 0);
            if (!prefix.toString('utf8', 0, length).startsWith('{"type":"opencode_session","storageVersion":2,"exportVersion":1,'))
                return true;
        }
        finally {
            fs.closeSync(fd);
        }
    }
    const stat = fs.statSync(filePath);
    return Math.floor(stat.mtimeMs) < Math.floor(sessionUpdatedMs);
}
function normalizeV2Part(part) {
    if (part.type !== 'tool')
        return part;
    const state = part.state;
    return {
        ...part, tool: part.name, callID: part.id,
        state: { ...state, output: state?.content ?? state?.error },
    };
}
function writeSessionTranscript(db, session, filePath, v2 = false) {
    const messages = db.prepare(`
    SELECT id, session_id, time_created, time_updated, data${v2 ? ", type" : ""}
    FROM ${v2 ? "session_message" : "message"}
    WHERE session_id = ?
    ORDER BY ${v2 ? "seq" : "time_created, id"}
  `).all(session.id);
    const partsByMessage = new Map();
    if (messages.length > 0) {
        const parts = db.prepare(`
      SELECT ${v2 ? "message_id || '_' || ordinal AS id, type" : "id"}, message_id, session_id, time_created, time_updated, data
      FROM ${v2 ? "session_part" : "part"}
      WHERE session_id = ?
      ORDER BY ${v2 ? "message_id, ordinal" : "time_created, id"}
    `).all(session.id);
        for (const part of parts) {
            const list = partsByMessage.get(part.message_id) || [];
            list.push(part);
            partsByMessage.set(part.message_id, list);
        }
    }
    const lines = [];
    lines.push(JSON.stringify({
        type: 'opencode_session',
        ...(v2 ? { storageVersion: 2, exportVersion: 1 } : {}),
        session: {
            id: session.id,
            projectID: session.project_id,
            slug: session.slug,
            directory: session.directory,
            title: session.title,
            version: session.version,
            parentID: session.parent_id || undefined,
            agent: session.agent || undefined,
            model: safeParseJson(session.model),
            time: {
                created: session.time_created,
                updated: session.time_updated,
            },
        },
        project: {
            name: session.project_name || undefined,
            worktree: session.project_worktree || undefined,
        },
    }));
    for (const message of messages) {
        const parsedMessage = safeParseJson(message.data);
        const messageData = parsedMessage && typeof parsedMessage === 'object'
            ? parsedMessage
            : { raw: parsedMessage };
        const parts = (partsByMessage.get(message.id) || []).map(part => {
            const parsedPart = safeParseJson(part.data);
            const partData = parsedPart && typeof parsedPart === 'object'
                ? parsedPart
                : { raw: parsedPart };
            return {
                ...partData,
                ...(v2 ? normalizeV2Part(partData) : {}),
                id: part.id,
                sessionID: part.session_id,
                messageID: part.message_id,
                timeCreated: part.time_created,
                timeUpdated: part.time_updated,
            };
        });
        // Completed assistants can be folded into message.data.content; streaming
        // assistants use ordinal session_part rows instead (V2 projector.ts).
        if (v2 && parts.length === 0 && Array.isArray(messageData.content)) {
            parts.push(...messageData.content.map(part => normalizeV2Part(part)));
        }
        // V2 user/synthetic text is stored on the message, not in session_part.
        if (v2 && ['user', 'synthetic'].includes(message.type || '') && typeof messageData.text === 'string') {
            parts.unshift({ type: 'text', text: messageData.text });
        }
        lines.push(JSON.stringify({
            type: 'opencode_message',
            sessionID: message.session_id,
            message: {
                ...messageData,
                ...(v2 ? {
                    type: message.type,
                    role: message.type === 'assistant' ? 'assistant'
                        : ['user', 'synthetic'].includes(message.type || '') ? 'user' : undefined,
                } : {}),
                id: message.id,
                sessionID: message.session_id,
                timeCreated: message.time_created,
                timeUpdated: message.time_updated,
            },
            parts,
        }));
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tempPath, `${lines.join('\n')}\n`, 'utf-8');
    fs.renameSync(tempPath, filePath);
    const mtime = dateFromMillis(session.time_updated);
    fs.utimesSync(filePath, mtime, mtime);
}
export function exportOpencodeSessions(options = {}) {
    const dbPath = options.dbPath || getOpencodeDbPath();
    const transcriptDir = options.transcriptDir || getOpencodeTranscriptDir();
    const result = {
        exported: 0,
        skipped: 0,
        errors: [],
        dbPath,
        transcriptDir,
    };
    if (!fs.existsSync(dbPath)) {
        return result;
    }
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const hasV2 = ['session_v2', 'session_message', 'session_part'].every(t => tableExists(db, t));
        const hasV1 = ['session', 'message', 'part'].every(t => tableExists(db, t));
        const sessions = [];
        for (const v2 of [true, false]) {
            if (v2 ? !hasV2 : !hasV1)
                continue;
            const table = v2 ? 'session_v2' : 'session';
            const messageTable = v2 ? 'session_message' : 'message';
            const partTable = v2 ? 'session_part' : 'part';
            // Message/part updates can outlive the session row's timestamp during streaming.
            const rows = db.prepare(`
        SELECT s.*, ${v2 ? 's.parent_id' : 'NULL'} AS parent_id,
          MAX(s.time_updated,
            COALESCE((SELECT MAX(time_updated) FROM ${messageTable} WHERE session_id=s.id), 0),
            COALESCE((SELECT MAX(time_updated) FROM ${partTable} WHERE session_id=s.id), 0)) AS export_updated,
          p.name AS project_name, p.worktree AS project_worktree
        FROM ${table} s LEFT JOIN project p ON p.id=s.project_id
        ${!v2 && hasV2 ? 'WHERE NOT EXISTS (SELECT 1 FROM session_v2 v WHERE v.id=s.id)' : ''}
        ORDER BY s.time_updated, s.id
      `).all();
            sessions.push(...rows.map(row => ({ ...row, time_updated: row.export_updated, v2 })));
        }
        for (const session of sessions) {
            try {
                const filePath = getOpencodeTranscriptFilePath(transcriptDir, {
                    sessionId: session.id,
                    directory: session.directory,
                });
                if (!shouldExportSession(filePath, session.time_updated, session.v2)) {
                    result.skipped++;
                    continue;
                }
                writeSessionTranscript(db, session, filePath, session.v2);
                result.exported++;
            }
            catch (error) {
                result.errors.push({
                    sessionId: session.id,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
    catch (error) {
        result.errors.push({
            error: error instanceof Error ? error.message : String(error),
        });
    }
    finally {
        db.close();
    }
    return result;
}
