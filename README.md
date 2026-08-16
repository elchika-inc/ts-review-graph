# ts-review-graph

[![CI](https://github.com/elchika-inc/ts-review-graph/actions/workflows/ci.yml/badge.svg)](https://github.com/elchika-inc/ts-review-graph/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@elchika-inc/ts-review-graph)](https://www.npmjs.com/package/@elchika-inc/ts-review-graph)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

Build a TypeScript dependency graph in SQLite and tell Claude Code (via MCP) the **minimal file set to read** before any code review, implementation, or debugging session.

> **日本語**: TypeScript プロジェクトの依存グラフを SQLite に構築し、コードレビュー・実装・デバッグ前に「読むべき最小ファイルセット」を Claude Code (MCP) に伝えるツール。

## Why?

TypeScript の依存関係には、source の文字列や AST だけではなく、Compiler API と互換性のある module / symbol resolution を通さないと見えないものがあります。例えば non-relative import、型の宣言元、`implements` / `extends` の関係です。

ts-review-graph は ts-morph 経由で TypeScript Compiler API の module / symbol resolution を使い、その結果を SQLite graph に保存します。事前構築した graph から変更の blast radius を引くことで、関連度の高いファイルを先に読めます。

### 0.5.5 co-change ベンチマーク

3つの TypeScript repository から固定フィルタで抽出した451 commit において、過去に共変更されたファイルの平均 recall は次のとおりでした。

| Prediction | 平均 recall | 中央 recall | 平均 precision |
|---|---:|---:|---:|
| `review` | **41.12%** | 25.00% | 15.66% |
| `implement` | **55.27%** | 50.00% | 10.26% |
| 同一 directory の全 TypeScript file | 19.28% | 0.00% | 9.19% |
| graph 内の全 tracked TypeScript file | 94.10% | 100.00% | 0.85% |

また、`node_modules` を除いてプロジェクト内へ解決できた import 1,862件のうち、972件（**52.20%**）は `./` / `../` で始まらない specifier でした。この結果は、相対 specifier の文字列追跡だけでは不十分で、Compiler API と互換性のある module resolution が重要であることを支持します。個々の specifier が `paths`、`baseUrl`、package exports のどれで解決されたかは分類していません。

一方、reverse traversal から `IMPORTS_FROM` 以外の型エッジを除いた ablation（`HAS_TEST` は維持）では、451 commit すべてで recall の低下が 0 でした。このデータセットは型エッジ自体の co-change recall 寄与を支持していません。条件・repository 別の数値と限界は [BENCHMARK.md](./BENCHMARK.md) を参照してください。

> **比較の限界**: 型エッジ ablation は「型エッジを持たない」という一点に限って構文レベルのパーサを近似したものであり、`IMPORTS_FROM` 自体は Compiler API で解決しています。code-review-graph そのものを実行した比較ではありません。

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

既に `[mcp_servers.ts-review-graph]` がある場合はエントリを重複させません。**`args` がある場合**、更新できるかは `args` に `@elchika-inc/ts-review-graph-mcp-server` の指定があるかで決まります。指定があれば `command` の値（`docker` 等）に関わらず、その version 指定だけを差し替えます（version が付いていなければ付与します）。**`args` が無い場合**は、`command` が `npx` か未指定のときにかぎり既定の `args` を書き足します。`--log-level debug` のように独自に足した引数はそのまま残り、`command` を独自の値へ変えている場合もそれを保持します（`command` が無いときだけ `"npx"` を補います）。`env` は書かず、既存の `TS_REVIEW_GRAPH_DB`（`.mcp.json` から写したパスなど）があれば除去します — `env` の他のキーはそのまま残ります（`env` が複数行のインラインテーブルの場合は、1行へ畳むとファイルが壊れるため触りません）。他の `[mcp_servers.*]` エントリや他のセクションには触れません。

次のいずれかに当てはまるエントリは、どう起動したいのかを推測できないため**そのエントリだけ更新せず警告します**（`env` も含めて一切変更しません）。`install` 自体は続行し、`.mcp.json` などは通常どおり更新されるので、version の更新が必要なら `.codex/config.toml` を手動で編集してください。

- `args` に `@elchika-inc/ts-review-graph-mcp-server` の指定が無い
- `args` が無く `command` が `npx` 以外（`command = "docker"` など）
- `command` または `args` をドット記法（`command.foo = ...`）やサブテーブル（`[mcp_servers.ts-review-graph.command]`、その配下も含む）で書いている
- `mcp_servers` や `mcp_servers.ts-review-graph` をインラインテーブル・ドット記法（`ts-review-graph = { ... }` など）で定義している

スキップされた場合、**`[mcp_servers.ts-review-graph]` というテーブル見出しがファイルに無いときは、エントリの新規追加も行いません**（末尾に見出しを足すと TOML 仕様違反になる、あるいはどこへ足すべきか決められないため）。上の条件のうち、見出しが無い形で起きるのは次の3つです。

1. `mcp_servers = { ... }` のように `mcp_servers` 自体をインラインテーブルで定義している場合。`install` はインラインテーブルの中身までは解釈しないので、`ts-review-graph` エントリが既にあるかどうかも判定できません（エントリが無ければ Codex から使えず、既にあっても version は自動更新されません）。→ `mcp_servers` をテーブル見出し記法（`[mcp_servers]`）へ書き直してください。
2. `[mcp_servers]` の下に `ts-review-graph = { ... }` と書く、または `mcp_servers.ts-review-graph.command = "npx"` のようにドット記法で書いている場合。→ その定義を `[mcp_servers.ts-review-graph]` 見出しと、その直下の通常のキーへ書き直してください。
3. `[mcp_servers.ts-review-graph]` 本体を書かずに `[mcp_servers.ts-review-graph.command]` / `[mcp_servers.ts-review-graph.args]`（およびその配下）の子テーブルだけを書いている場合。→ `command` / `args` を `[mcp_servers.ts-review-graph]` 直下の通常のキーへ書き直してください。

いずれも、書き直してから `install` を再実行するか、`[mcp_servers.ts-review-graph]` を手動で設定してください。

既存の `.codex/config.toml` を**そもそも正しく読めない**場合（値や文字列が閉じていない、括弧の対応が取れていない、テーブル見出しを解釈できない、`[mcp_servers.ts-review-graph]` セクションやその子テーブル（`[mcp_servers.ts-review-graph.env]` など）、あるいはその配下のキーが重複定義されている、`[[mcp_servers.ts-review-graph]]` で定義されている等）、`install` は `.ts-review-graph/config.json`・`.mcp.json`・`.codex/config.toml`・`CLAUDE.md` を**いずれも書かずに中止します**（グラフ構築も行われません）。ただし中止より前に実行される `.gitignore` の除外設定と `.ts-review-graph/ignore` の雛形作成は、中止時にも残ることがあります（どちらも冪等です）。表示されたエラーメッセージに従って該当箇所を修正（閉じていない文字列・括弧なら閉じる、重複定義は1つへ統合、`[[...]]` は通常のテーブル見出しへ）してから `install` を再実行してください。

既知の制限:

- **project 単位の設定が読まれるのは trust 済みの project だけです。** trust されていない project では Codex が `.codex/config.toml` の `mcp_servers` を読み込まないため、`~/.codex/config.toml` へ同じ `[mcp_servers.ts-review-graph]` を手動で登録してください。trust 状態は `~/.codex/config.toml` 側に `trust_level = "trusted"` として記録されます。
- **Codex から使えるのは `.codex/config.toml` 経由で登録される MCP tools です。** Claude Code plugin が導入する commands・hooks・skills は `claude plugin install` で Claude Code 側に入るもので、対象 project のディレクトリには置かれないため Codex からは読み込まれません（Codex 自身の hooks / skills 機構とは別物です）。plugin が提供する `Read` 時のブラスト半径アドバイザリ表示も Codex では働きません。`install` が使用方法を追記するのは `CLAUDE.md` なので、Codex のエージェントに恒常的に守らせたい場合は同じ内容を `AGENTS.md` へコピーしてください。
- **Codex 用の書き込みだけを省く option はありません。** `install` は常に `.codex/config.toml` を作成・更新します（Codex を使わない project にも作られます）。
- **`uninstall` は `.codex/config.toml` を自動削除しません**（手動削除の案内のみ出します）。
- custom `--db` を指定した場合でも Codex 用エントリには `env` を書かないため、Codex 側は既定の `.ts-review-graph/graph.db` を参照します。エントリが更新対象の場合、`.codex/config.toml` へ手動で `TS_REVIEW_GRAPH_DB` を足しても次の `install` で除去されるため、custom DB を Codex から使う場合は `~/.codex/config.toml` 側のエントリか、Codex 起動時の環境変数で指定してください。

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
MCP `graph_status` remains quarantine-exempt — it never refuses — and prints the same verdict on its own `health:` line (`OK` / `MISMATCH (reason) — detail` / `STALE (n/m files changed)`, or `判定できません: …` when the check itself fails), so the one tool you use to inspect a broken graph does not report "normal" while the other six refuse.

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

| Package | Description |
|---|---|
| `@elchika-inc/ts-review-graph` | CLI tool |
| `@elchika-inc/ts-review-graph-mcp-server` | MCP server |
| `@elchika-inc/ts-review-graph-core` | Graph build & query engine |

## Links

- [BENCHMARK.md](./BENCHMARK.md) — benchmark data
- [CHANGELOG.md](./CHANGELOG.md) — release notes
