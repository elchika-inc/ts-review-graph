# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-08-09

### Breaking Changes
- `graph.db` のスキーマを変更した。**既存のグラフは再構築が必要**（`ts-review-graph build`）
- `analyzeProject` / `updateFile` / `buildFullGraph` に `projectRoot` 引数を追加した
- `install` が `.mcp.json` に `TS_REVIEW_GRAPH_DB` を書き込まなくなった

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
