# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.5]

### Added
- `install` が Claude Code 用の `.mcp.json` に加えて Codex 用の `.codex/config.toml` にも MCP server を登録するようにした。version 固定・`env` なしで冪等に追記し、既存エントリがあれば `args` 内の version 指定だけを差し替える（独自に足した引数・`command` の独自値は保持し、既存 `env` からは `TS_REVIEW_GRAPH_DB` のみを除去する）。`args` に ts-review-graph の package 指定が無い・`args` が無く `command` が `npx` 以外・`command`/`args` がドット記法やサブテーブル・`mcp_servers` やエントリがインラインテーブル記法、のいずれかに当てはまる場合は推測で書き換えず、そのエントリだけ更新せずに警告して `install` は続行する（そのエントリの `env` にも触れない）。`mcp_servers` がインラインテーブルの場合と子テーブルだけがある場合は、エントリの新規追加も行わない。他の `[mcp_servers.*]` エントリ・他のセクションには触れない
- 既存の `.codex/config.toml` をそもそも正しく読めない場合（値や文字列が閉じていない、重複定義等）は、`install` が `config.json`・`.mcp.json`・`.codex/config.toml`・`CLAUDE.md` をいずれも書かずに中止する（fail-closed。既存手順どおり `.gitignore` と `.ts-review-graph/ignore` は中止前に作成され得る）
- `uninstall` が `.codex/config.toml` の手動削除を案内するようにした
- README に Codex での利用方法と既知の制限（trust 済み project でのみ project 単位設定が読まれる・Claude Code plugin の hooks は Codex では読み込まれない）を追記した

### Fixed
- MCP サーバーが DB のオープンに失敗したとき、全ツールが「グラフ未構築 — build_graph を呼び出してください」を返して原因を隠していた問題を、オープン失敗と未構築を区別し、失敗理由と（Node ABI 不一致なら）npx キャッシュ削除の復旧手順を返すよう修正した
- degraded mode が案内する復旧経路である `build_graph` 自体の DB オープン失敗に、ABI 不一致の復旧手順が付いていなかった問題を修正した

### Changed
- Node ABI 不一致の診断を `packages/core` へ移し、CLI と MCP サーバーが同一の実装を参照するようにした（CLI の出力は変更なし）

## [0.5.4] - 2026-08-13

### Added
- `cli/package.json` を正本として公開 package と Claude Code plugin 配布物の version を同期する `pnpm sync-version` を追加した

### Fixed
- project root と対象ファイルで論理パス・物理パスが混在すると、同じプロジェクト内でもルート外と誤判定していた問題を、通常判定が失敗した場合だけ `realpathSync` で再判定するよう修正した

### Changed
- リリース時の lockstep version 更新を、複数箇所の手動編集から `cli/package.json` の編集と同期スクリプト実行へ変更した

## [0.5.3] - 2026-08-13

### Fixed
- PreToolUse(Read) hook のブラスト半径と旧形式グラフ警告を、Claude に届かない平文 stdout ではなく `hookSpecificOutput.additionalContext` の構造化 JSON として出力するよう修正した
- フックが生成する JSON で、ファイルパスに含まれる引用符・バックスラッシュ・改行・タブ・その他の制御文字を追加依存なしでエスケープするよう修正した

## [0.5.2] - 2026-08-12

### Added
- Claude Code plugin を配布する marketplace manifest と導入手順を追加した

### Security
- plugin の hook と skill が unscoped の `ts-review-graph` package を `npx` 実行・案内していた経路を、plugin version に固定した `@elchika-inc/ts-review-graph` へ置き換えた

### Fixed
- plugin の MCP server が gitignore 済みの `dist/` と空の `TS_REVIEW_GRAPH_DB` に依存していた問題を、version 固定した公開 MCP package の利用により修正した
- plugin hook manifest の event を必要な `hooks` 階層配下へ移し、Claude Code の plugin validation が失敗する問題を修正した
- hook command 内の `$CLAUDE_PLUGIN_ROOT` を引用し、plugin の install path に空白があると script を起動できない問題を修正した
- `build` command が MCP schema に存在しない `tsconfig` 引数を案内していた問題を、`tsconfigs` 配列へ修正した
- PreToolUse / PostToolUse hook が symlink 成分を含む論理・物理パスを混在させて照会・増分更新に失敗する問題を、両ルートを扱う共通の project 相対パス化により修正した
- `.gitignore` の `.ts-review-graph/graph.db*` を canonical な DB・WAL・SHM 3行へ置き換え、glob 行が孤立して残る問題を修正した
- Node ABI 不一致時の npx cache 削除案内を `install` だけでなく `build`・`update`・`status` にも表示するようにした

### Changed
- Claude Code plugin の version を公開 package と同じ `0.5.1` へ揃えた

## [0.5.1] - 2026-08-09

### Security
- `install` が生成する `.mcp.json` で MCP server を CLI と同じ version に固定し、セッション起動時に未確認の `latest` や旧 reader が選ばれる経路を閉じた

### Fixed
- SQLite の `graph.db-wal` / `graph.db-shm` も `.gitignore` へ冪等に追加し、WAL 関連ファイルが誤ってコミットされる問題を修正した
- npx cache 内のネイティブ module が Node ABI 不一致で失敗した場合、エラーから抽出できた `_npx/<hash>` の削除コマンドを表示し、抽出不能時は一般的な cache 削除案内に留めるようにした

### Changed
- MCP server の修正版は自動受信されなくなった。version を更新するには、更新後の CLI version で初回と同じ `--tsconfig` / `--db` option を指定し、`install` を再実行する必要がある

## [0.5.0] - 2026-08-09

### Breaking Changes
- `graph.db` のスキーマを変更した。**既存のグラフは再構築が必要**（`ts-review-graph build`）
- `analyzeProject` / `updateFile` / `buildFullGraph` に `projectRoot` 引数を追加した
- `install` は既定 DB の場合 `.mcp.json` に `TS_REVIEW_GRAPH_DB` を書き込まなくなった。`--db` で既定以外を指定した場合のみ、プロジェクトルート相対値を書き込む

### Fixed
- リポジトリの移動・worktree・別マシンでのクローン後に、絶対パスで保存されたグラフが無言で全件ミスしていた問題を、プロジェクトルート相対パス保存とグラフ検疫により修正した

## [0.4.0] - 2026-08-09

### Added
- **`get_impact` の Mermaid 出力** — `format: "mermaid"` で GitHub ネイティブの flowchart を出力できるようにした。ノードは最大50件に制限し、打ち切り時は省略件数を明示する
- **`find_cycles` ツール** — `IMPORTS_FROM` エッジ上のファイル単位の循環依存を検出する8個目の MCP ツールを追加した

### Fixed
- **バレル re-export の依存グラフ反映** — `export * from` / `export { x } from` 経由の依存を `IMPORTS_FROM` エッジとして記録し、blast radius から利用者が欠落する問題を full build・増分更新の両経路で修正した

## [0.3.5] - 2026-05-06

### Fixed
- **`updateFile` return value on deletion** — when the target file no longer exists, `updateFile` now returns `"deleted"` instead of `"skipped"`, distinguishing "no hash change" from "node cleanup on removal"
- **`HAS_TEST` loop `node_modules` filter** — the source test file is now also checked against `node_modules` (previously only the resolved implementation file was checked), making the filter symmetric with the main analysis loop
- **`get_minimal_context` review/debug mode** — the changed file itself is now excluded from the "READ THESE FILES ONLY" list (consistent with `implement` mode behaviour); SKIP count continues to use `reverseFiles.size` which includes the changed file
- **`build` command DB connection leak** — statistics queries are now inside the `buildFullGraph` try block so `finally { db?.close() }` runs even when the build fails
- **`update` CLI output** — adds a `"deleted"` message branch and notes that `TYPED_BY`/`IMPLEMENTS`/`EXTENDS`/`HAS_TEST` edges are restored on the next `build`
- **`db.test.ts` test isolation** — `Date.now()` replaced with `randomUUID()` in `beforeEach`; each test now wraps DB operations in `try/finally` to guarantee `db.close()` on assertion failure

## [0.3.4] - 2026-05-06

### Fixed
- **Relative path resolution in `get_impact`, `get_test_coverage`, `query_graph`** — these tools now call `resolveFilePath()` before passing the file path to SQLite queries and `computeBlastRadius()`. Previously, relative paths produced empty results because the DB stores node paths as absolute paths. Absolute paths continue to work unchanged.
- **`\r\n` injection rejection in `resolveFilePath`** — paths containing carriage return or newline characters are now rejected immediately with `Path traversal detected`, preventing log-injection attacks and malformed SQL via CRLF.
- **Extracted shared `resolve-path.ts` module** — `resolveFilePath()` is now a single source of truth used by all four MCP tools (`get_minimal_context`, `get_impact`, `get_test_coverage`, `query_graph`).

## [0.3.3] - 2026-05-05

### Fixed
- **`HAS_TEST` edge FK violation** — `analyzeProject` now skips `node_modules` paths when creating `HAS_TEST` edges. Previously, test files importing from packages that ship TypeScript source (e.g. `vitest`) caused a `FOREIGN KEY constraint failed` error because the resolved `node_modules` path was used as `source_id` but never inserted into the `nodes` table.
- **Cross-tsconfig FK violation in `buildFullGraph`** — insertion is now split into three passes (all nodes → all edges → all hashes) so that edges from one tsconfig can safely reference nodes from another tsconfig. The previous single-loop approach inserted edges before the target tsconfig's nodes were present.

## [0.3.2] - 2026-05-03

### Added
- **`install` command now appends ts-review-graph usage section to `CLAUDE.md`** — idempotent (skips if marker already present); creates `CLAUDE.md` if it doesn't exist

## [0.3.1] - 2026-05-03

### Fixed
- **`pnpm publish` instead of `npm publish`** for workspace:* dependency resolution (workspace protocol is now correctly converted to semver on publish)

## [0.3.0] - 2026-05-03

### Fixed
- **Symlink bypass protection** in `resolveFilePath`: `realpathSync` check now detects symlinks that escape the project root (fail-closed on `EACCES`/`ELOOP`)
- **`buildFullGraph` prepared statement cache**: extended `WeakMap` to include bulk-delete statements (`deleteAllEdges`, `deleteAllNodes`, `deleteAllHashes`), eliminating redundant `db.prepare()` calls on repeated invocations
- **Test isolation**: replaced `Date.now()`-based temp paths with `randomUUID()` in `updater.test.ts` and `tools.test.ts` — safe for parallel test execution
- **`get_impact` self-exclusion test**: improved assertion to use exact file path variable instead of fragile substring match

### Changed
- `buildFullGraph` now uses the shared `getUpdateStmts(db)` cache for all prepared statements (consistent with `updateFile`)
- `buildFullGraph` test fixture cleanup wrapped in `try/finally` to guarantee temp dir removal on failure

## [0.2.0] - 2026-05-01

### Added
- **FORWARD BFS (depth=1)** in `implement` mode: returns files the changed file directly imports, identifying co-change candidates (#3 upstream detection)
- **multi-tsconfig support**: `build_graph` now accepts `.ts-review-graph/config.json` with `tsconfigs: []` array to build graphs from multiple `tsconfig.json` files in a single pass
- **`resolveFilePath`**: MCP tool now accepts relative paths (relative to project root), not just absolute paths
- **`isError: true`** on error responses per MCP protocol spec
- **Path traversal protection** in `resolveFilePath` — rejects `../../` inputs
- **Runtime argument validation** for `get_minimal_context` tool inputs
- **MIT LICENSE** file
- **CHANGELOG.md** (this file)

### Changed
- `buildFullGraph` now runs `analyzeProject` **outside** the SQLite transaction, drastically reducing DB write lock time during TypeScript analysis
- MCP server version bumped to `0.2.0` (was hardcoded `0.1.0`)
- RECURSIVE CTE changed from `UNION ALL` to `UNION` to prevent infinite loops on circular imports
- Error message for unbuilt graph now references `build_graph` tool instead of CLI command
- `db` variable in MCP server is now mutable and re-opened after `build_graph` succeeds

### Fixed
- Circular import graphs no longer cause infinite SQL recursion (#1)
- `get_minimal_context` now works when called after `build_graph` in the same MCP session (#6)
- `build_graph` error response now sets `isError: true` (#6)
- Path traversal via `changed_files: ["../../etc/passwd"]` is now rejected (#5)

### Package
- Added `files: ["dist", "README.md", "LICENSE"]` to `package.json` for clean npm publish
- Added `publishConfig: { access: "public" }`
- Bumped both `@elchika-inc/ts-review-graph-core` and `@elchika-inc/ts-review-graph-mcp-server` to `0.2.0`

## [0.1.0] - 2026-04-01

### Added
- Initial release
- TypeScript dependency graph builder using ts-morph
- SQLite storage via better-sqlite3
- MCP server with tools: `get_minimal_context`, `get_impact`, `get_type_usages`, `get_test_coverage`, `query_graph`, `build_graph`, `graph_status`
- REVERSE BFS blast radius computation for `review` mode
- Basic `implement` and `debug` modes (REVERSE only in v0.1)
