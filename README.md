# ts-review-graph

[![CI](https://github.com/elchika-inc/ts-review-graph/actions/workflows/ci.yml/badge.svg)](https://github.com/elchika-inc/ts-review-graph/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@elchika-inc/ts-review-graph)](https://www.npmjs.com/package/@elchika-inc/ts-review-graph)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

Build a TypeScript dependency graph in SQLite and tell Claude Code (via MCP) the **minimal file set to read** before any code review, implementation, or debugging session.

> **日本語**: TypeScript プロジェクトの依存グラフを SQLite に構築し、コードレビュー・実装・デバッグ前に「読むべき最小ファイルセット」を Claude Code (MCP) に伝えるツール。

## Why?

Claude Code reads too many files. It grabs large files one after another and stuffs unrelated code into its context.

ts-review-graph pre-builds the project's dependency graph and instantly computes the **blast radius** (impact surface) of changed files — so Claude only reads what matters.

### Real-world benchmark (manako project)

From [BENCHMARK.md](./BENCHMARK.md):

| Metric | Baseline | ts-review-graph | Reduction |
|---|---|---|---|
| `Read` tool calls | 14 | 3 | **−79%** |
| File content bytes | 219,139 | 58,583 | **−73%** |
| Estimated tokens | ~54,784 | ~14,645 | **−73%** |

Graph size: 1,191 nodes / 1,400+ edges (Cloudflare Workers monorepo)

## Requirements

- **Node.js 20+**

## Installation

### Single tsconfig

```bash
npx @elchika-inc/ts-review-graph@latest install --tsconfig tsconfig.json
```

Config is saved to `.ts-review-graph/config.json`, MCP server is registered in `.mcp.json`, and usage instructions are appended to `CLAUDE.md`. Restart Claude Code and the MCP server connects automatically.

### Monorepo (multiple tsconfigs)

```bash
npx @elchika-inc/ts-review-graph@latest install \
  --tsconfig apps/api/tsconfig.json \
  --tsconfig apps/web/tsconfig.app.json \
  --tsconfig apps/worker/tsconfig.json
```

Multiple tsconfigs are merged into a single unified graph (tested with 1,191+ nodes across layers).

## Usage

### In Claude Code (automatic)

Claude calls `get_minimal_context` automatically before reading source files:

```
get_minimal_context(["src/routes/monitors.ts"], "implement")
```

Example output (`implement` mode, apps/web + apps/api):

```
Changed: src/routes/monitors.ts

── Files affected (REVERSE depth=3) ──
  1. src/routes/services.ts   [IMPORTS_FROM]

── Files to change together (FORWARD depth=1) ──
  1. src/env.ts               [direct import]
  2. src/lib/schemas.ts       [direct import]
  3. src/lib/format.ts        [direct import]
  4. packages/db/src/index.ts [direct import]

SKIP: 1170 other files — not in blast radius
```

### CLI commands

| Command | Description |
|---|---|
| `npx @elchika-inc/ts-review-graph@latest install --tsconfig <path>` | Setup + initial build + register MCP + append `CLAUDE.md` |
| `npx @elchika-inc/ts-review-graph build [--tsconfig <path>]... [--db <path>]` | Rebuild the graph |
| `npx @elchika-inc/ts-review-graph update <file> [--db <path>]` | Incremental update for a single file |
| `npx @elchika-inc/ts-review-graph status [--db <path>]` | Show graph statistics |
| `npx @elchika-inc/ts-review-graph uninstall` | Remove MCP registration |

### MCP tools

| Tool | Key args | Description |
|---|---|---|
| `get_minimal_context` | `changed_files[]`, `mode` (default: `"review"`) | Minimal file set (REVERSE/FORWARD BFS) |
| `get_impact` | `changed_file`, `format` (`"text"` / `"mermaid"`) | Files affected by a change, with depth |
| `get_type_usages` | `type_name` | Nodes that reference a type |
| `get_test_coverage` | `file` | Corresponding test files |
| `query_graph` | `from`, `edge_kind`, `direction`, `depth` | General-purpose graph traversal |
| `find_cycles` | `max_cycles` (default: `20`) | File-level circular imports |
| `build_graph` | `tsconfigs[]` (optional) | Rebuild the graph |
| `graph_status` | — | Graph statistics |

### Graph health checks

Every graph-reading tool validates the graph before answering:

| Condition | Behavior |
|---|---|
| `meta` table missing, or `schema_version` mismatch | **Refuses** — rebuild required |
| `config.json` tsconfigs differ from the recorded set (or `config.json` missing) | **Refuses** — rebuild required |
| Known files changed on disk since the graph was built | Answers, prefixed with `⚠ STALE: N files changed` |

`ts-review-graph status` reports the same verdict on a `health:` line.

Graph paths are stored relative to the project root, so `graph.db` survives
moving the repository, working in a git worktree, or cloning on another machine.

### BFS depth by mode

| Mode | REVERSE | FORWARD | Use case |
|---|---|---|---|
| `review` | depth=2 | — | Pre-review impact analysis (downstream) |
| `implement` | depth=3 | depth=1 (direct imports only) | Pre-implementation change surface (bidirectional) |
| `debug` | depth=5 | — | Wide exploration for bug investigation |

## Configuration

`.ts-review-graph/config.json` (auto-generated by `install`, commit to repo):

```json
{
  "tsconfigs": [
    "apps/api/tsconfig.json",
    "apps/web/tsconfig.app.json",
    "apps/monitor-worker/tsconfig.json"
  ]
}
```

`graph.db` is a build artifact — added to `.gitignore` automatically. Share `config.json` with your team.

## How it works

### Build phase

1. Load each `tsconfig.json`
2. Walk the AST using the TypeScript Compiler API
3. Extract import/export/type relationships
4. Store nodes and edges in SQLite (`graph.db`)

### Query phase

1. Specify changed files (`["src/routes/monitors.ts"]`)
2. Run BFS in the selected mode:
   - **REVERSE**: who imports this file (downstream impact)
   - **FORWARD**: what this file imports (upstream co-change candidates)
3. Return only files within the blast radius

## Tech stack

- **Language**: TypeScript 5.4+
- **Database**: SQLite 3 (better-sqlite3)
- **Graph traversal**: SQL recursive CTE (`WITH RECURSIVE`)
- **MCP**: Model Context Protocol SDK v1.0.0
- **CLI**: Commander.js 12.0.0

## License

MIT

---

## Packages

| Package | Description | Version |
|---|---|---|
| `@elchika-inc/ts-review-graph` | CLI tool | 0.3.0 |
| `@elchika-inc/ts-review-graph-mcp-server` | MCP server | 0.3.0 |
| `@elchika-inc/ts-review-graph-core` | Graph build & query engine | 0.3.0 |

## Links

- [BENCHMARK.md](./BENCHMARK.md) — benchmark data
- [CHANGELOG.md](./CHANGELOG.md) — release notes
