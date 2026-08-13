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
- Claude Code plugin を使う場合は **bash** と **sqlite3 CLI**

## Installation

### Single tsconfig

```bash
npx @elchika-inc/ts-review-graph@latest install --tsconfig tsconfig.json
```

Config is saved to `.ts-review-graph/config.json`, MCP server is registered in `.mcp.json` (Claude Code) and `.codex/config.toml` (Codex), and usage instructions are appended to `CLAUDE.md`. Restart Claude Code and the MCP server connects automatically.

生成される `.mcp.json` は、MCP server を `install` に使用した CLI と同じ version に固定します。これにより、セッション起動時に古い graph reader や未確認の将来の `latest` release が選ばれることを防ぎます。トレードオフとして修正版は自動受信されないため、ts-review-graph の更新時は更新後の CLI version で、初回と同じ `--tsconfig` / `--db` option を指定して `install` を再実行してください。

### Monorepo (multiple tsconfigs)

```bash
npx @elchika-inc/ts-review-graph@latest install \
  --tsconfig apps/api/tsconfig.json \
  --tsconfig apps/web/tsconfig.app.json \
  --tsconfig apps/worker/tsconfig.json
```

Multiple tsconfigs are merged into a single unified graph (tested with 1,191+ nodes across layers).

### Claude Code plugin（任意）

既存の CLI `install` はグラフ構築と MCP server 登録を行います。Claude Code plugin はそれに加えて commands・hooks・skills を導入し、`Read` のたびにブラスト半径をアドバイザリ表示する hook を有効にします。

```bash
claude plugin marketplace add elchika-inc/ts-review-graph
claude plugin install ts-review-graph
```

plugin 自体はグラフを構築しません。plugin 導入前または導入後に、対象 project で CLI の `install` を別途実行してください。既に `config.json` がある場合は `build` でも再構築できますが、plugin は既定の `.ts-review-graph/graph.db` だけを参照するため、custom `--db` は使わないでください。

plugin を更新するには `claude plugin update ts-review-graph` を実行し、Claude Code を再起動します。CLI も更新する場合は、更新後の CLI version で初回と同じ option を指定して `install` を再実行してください。

### Codex

`install` は Claude Code 用の `.mcp.json` に加えて、Codex の project 単位設定 `.codex/config.toml` にも同じ MCP server を登録します。書き込まれる内容は次の形で、version は `install` に使用した CLI と同じものに固定されます。

```toml
[mcp_servers.ts-review-graph]
command = "npx"
args = [
    "-y",
    "@elchika-inc/ts-review-graph-mcp-server@<install に使用した CLI と同じ version>",
]
```

既に `[mcp_servers.ts-review-graph]` がある場合はエントリを重複させず、`args` の中の ts-review-graph の version 指定だけを差し替えます（`--log-level debug` のように独自に足した引数はそのまま残ります）。`command` を独自の値へ変えている場合はそれを保持し、`command` が無いときだけ `"npx"` を補います。`env` は書かず、既存の `TS_REVIEW_GRAPH_DB`（`.mcp.json` から写したパスなど）があれば除去します — `env` の他のキーはそのまま残ります。他の `[mcp_servers.*]` エントリや他のセクションには触れません。

既存の `.codex/config.toml` に安全に更新できない記法（`mcp_servers` や `mcp_servers.ts-review-graph` をインラインテーブル・ドット記法・`[[...]]` で定義している、値や文字列が閉じていない等）が含まれる場合、`install` は `.ts-review-graph/config.json`・`.mcp.json`・`.codex/config.toml` を**いずれも書かずに中止します**（グラフ構築も行われません）。ただし中止より前に実行される `.gitignore` の除外設定と `.ts-review-graph/ignore` の雛形作成は、中止時にも残ることがあります（どちらも冪等です）。表示されたパスの該当箇所を通常のテーブル見出し記法へ手動で整理してから `install` を再実行してください。Codex 用の書き込みだけを省く option は現在ありません。

既知の制限:

- **project 単位の設定が読まれるのは trust 済みの project だけです。** trust されていない project では Codex が `.codex/config.toml` の `mcp_servers` を読み込まないため、`~/.codex/config.toml` へ同じ `[mcp_servers.ts-review-graph]` を手動で登録してください。trust 状態は `~/.codex/config.toml` 側に `trust_level = "trusted"` として記録されます。
- **Codex では MCP tools と skills は動作しますが、Claude Code plugin の hooks は読み込まれません。** plugin が提供する `Read` 時のブラスト半径アドバイザリ表示は Codex では働きません（Codex 自身の hooks 機構とは別物です）。`install` が使用方法を追記するのは `CLAUDE.md` なので、Codex に恒常的に守らせたい場合は同じ内容を `AGENTS.md` へコピーしてください。
- custom `--db` を指定した場合でも Codex 用エントリには `env` を書かないため、Codex 側は既定の `.ts-review-graph/graph.db` を参照します。`.codex/config.toml` へ手動で `TS_REVIEW_GRAPH_DB` を足しても次の `install` で除去されるため、custom DB を Codex から使う場合は `~/.codex/config.toml` 側のエントリか、Codex 起動時の環境変数で指定してください。

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
| `npx @elchika-inc/ts-review-graph@latest install --tsconfig <path> [--db <path>]` | Setup + initial build + register MCP + append `CLAUDE.md` |
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

The six graph-query tools (`get_minimal_context`, `get_impact`, `get_type_usages`,
`get_test_coverage`, `query_graph`, and `find_cycles`) validate the graph before answering:

| Condition | Behavior |
|---|---|
| `meta` table missing, or `schema_version` mismatch | **Refuses** — rebuild required |
| `config.json` tsconfigs differ from the recorded set (or `config.json` missing) | **Refuses** — rebuild required |
| Known files whose disk mtime is newer than their last full or incremental graph update, or which are missing from disk | Answers, prefixed with `⚠ STALE: N files changed` |

`ts-review-graph status` reports the same verdict on a `health:` line.
MCP `graph_status` remains quarantine-exempt so it can report raw diagnostics for a broken graph.

Graph paths are stored relative to the project root, so a `graph.db` moved or copied
with its working tree remains usable at the new root. Because `graph.db` is ignored,
a normal clone or newly created worktree does not contain it and requires `install` or `build`.

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

`graph.db` はビルド成果物です。既定 DB の `graph.db`・`graph.db-wal`・`graph.db-shm` は自動的に `.gitignore` へ追加されます。`--db` でリポジトリ内の別パスを指定した場合は、その DB・WAL・SHM を利用者が `.gitignore` へ追加してください。`config.json` はチームで共有してください。
Run CLI and MCP commands from the project root. `--db` changes only the database location;
it does not change which directory is treated as the project root.

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
