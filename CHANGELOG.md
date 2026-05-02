# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Bumped both `@ts-review-graph/core` and `@ts-review-graph/mcp-server` to `0.2.0`

## [0.1.0] - 2026-04-01

### Added
- Initial release
- TypeScript dependency graph builder using ts-morph
- SQLite storage via better-sqlite3
- MCP server with tools: `get_minimal_context`, `get_impact`, `get_type_usages`, `get_test_coverage`, `query_graph`, `build_graph`, `graph_status`
- REVERSE BFS blast radius computation for `review` mode
- Basic `implement` and `debug` modes (REVERSE only in v0.1)
