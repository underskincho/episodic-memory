# OpenCode V2.2.5 archival fix

Verified locally on 2026-11-04. No OpenCode configuration, model settings, NInfer settings, MCP registration, or installed idle hook configuration was changed. Compiled dist files have been rebuilt. The existing idle hook starts a new sync CLI process, which uses the updated exporter.

## What changed

- Export both V1 (`session/message/part`) and V2 (`session_v2/session_message/session_part`), preferring V2 when a migrated session ID exists in both tables.
- V2 messages follow `seq`, parts follow `ordinal`. User/synthetic text lives on the message. Completed assistant content can be folded into `message.data.content`; streaming assistant content uses separate parts. Both representations are supported, as verified against the exact V2.2.5 source and a real local database.
- Normalize native tool names, call IDs and result content into the existing archive/parser format. Preserve compaction/control records without fabricating assistant exchanges from them. Preserve session parentID and mark parsed child exchanges as sidechains.
- Use message/part update timestamps as well as session timestamps. Export headers distinguish V2 snapshots and refresh older-format exports of migrated IDs. Unchanged exports remain no-ops.
- The normal sync path now atomically replaces the index of a changed V2 snapshot after embeddings succeed. Append-only high-water indexing remains unchanged for other transcript formats. A rewritten/continued last answer therefore no longer leaves stale or duplicate indexed exchanges.

The OpenCode database is opened read-only. No new dependencies or services were installed. This fix does not alter the separate manual indexer’s general incremental strategy; use the normal sync path for mutable V2 exports.

## Real verification

`opencode-v2-live-retrieval.json` records the final live verification:

- 41 V2 exports refreshed, no export errors.
- 41 archive files copied; 40 processed by indexing under existing exclusion rules; zero summaries; no sync errors.
- Session `ses_e5dd79bf7ffeyEcNxtr9p3b1ad` archived successfully, parsed into an exchange, and found by a session-filtered text search for `HOLA`. It is correctly marked as a sidechain.
- Archive: `C:/Users/CHo/.config/superpowers/conversation-archive/PlanEjecutor/opencode-ses_e5dd79bf7ffeyEcNxtr9p3b1ad.jsonl`.

`opencode-v2-idempotence.json` records the next run: 0 exports, 103 skipped; 0 copies, 0 indexed, 0 summaries, no errors. The live verification called sync with `skipSummaries:true, summaryLimit:0`; it never called the summarizer or Anthropic. Existing automatic summary preferences were preserved.

## Tests

- Targeted exporter/parser/sync tests: **16 passed** (`opencode-v2-targeted-results.log`). Covers V1, V2-only, coexistence, migrated IDs, inline completed content, ordinal streaming parts, tools, compaction, parent metadata, incremental updates, snapshot replacement and idempotence.
- Build: `npm run build` passed.
- Full serial suite: **355 passed, 4 failed** across 64 test files (`opencode-v2-test-results.log`). The same four failures reproduced with the original parser and unchanged lock/installer code (`opencode-v2-baseline-results.log`): two fixture project-name expectations on Windows, a POSIX chmod expectation, and a SIGTERM child-process test timeout. These unrelated failures were left unchanged.

## Changed implementation files

- `src/opencode-sync.ts`
- `src/parser.ts`
- `src/sync.ts`
- `dist/opencode-sync.js`
- `dist/parser.js`
- `dist/parser.d.ts`
- `dist/sync.js`
- `dist/mcp-server.js` (rebuilt bundle)
- `test/opencode-v2-sync.test.ts`
- `test/sync-incremental-and-marker.test.ts`
- `CHANGELOG.md`
- This document and the two live-verification JSON files.

No release, commit, tag or publication was performed.
