# ts-review-graph

TypeScript プロジェクトの依存グラフを SQLite に構築し、コードレビュー・実装・デバッグ前に **「読むべき最小ファイルセット」** を Claude Code (MCP) に伝えるツール。

> **English summary**: ts-review-graph builds a TypeScript dependency graph in SQLite and exposes it via MCP to Claude Code. Before reading any source files, Claude calls `get_minimal_context` to get the **minimal blast-radius file set** — typically reducing token consumption by 50–79% compared to unguided exploration. See [BENCHMARK.md](./BENCHMARK.md) for benchmarks.

## なぜ使うのか

Claude Code はコードを読みすぎる。大きなファイルを次々と読んで、関係ないコードまでコンテキストに詰め込む。

ts-review-graph はプロジェクトの依存グラフを事前に構築し、**変更対象ファイルの blast radius**（影響範囲）を即座に計算して、Claude が読むべきファイルを絞り込む。

### 実測データ（manako プロジェクト）

[BENCHMARK.md](./BENCHMARK.md) より：

- **Read ツール呼び出し**: 14回 → 3回（**-79%**）
- **ファイルコンテンツトークン**: ~54,784 → ~14,645（**-73%**）

606 ノード / 752 エッジの依存グラフから、変更 3 ファイルの blast radius のみ抽出。

## 前提条件

- **Node.js 20 以上**

## インストール

### クイックスタート（単一 tsconfig）

```bash
npx ts-review-graph@latest install --tsconfig tsconfig.json
```

設定は `.ts-review-graph/config.json` に保存されます。Claude Code を再起動すると MCP が自動接続されます。

### モノレポ（複数 tsconfig）

```bash
npx ts-review-graph@latest install \
  --tsconfig apps/api/tsconfig.json \
  --tsconfig apps/web/tsconfig.app.json \
  --tsconfig apps/worker/tsconfig.json
```

複数 tsconfig を指定すると、全アプリのグラフを統合（1,191 ノード以上のマルチレイヤー対応）。

## 使い方

### Claude Code での利用（自動）

実装タスク前に Claude が自動的に呼び出します:

```
get_minimal_context(["src/routes/monitors.ts"], "implement")
```

出力例（implement モード、apps/web + apps/api）:

```
Changed: src/routes/monitors.ts

── 影響を受けるファイル（REVERSE depth=3） ──
  1. src/routes/services.ts   [IMPORTS_FROM]

── 一緒に変えるべきファイル（FORWARD depth=1） ──
  1. src/env.ts               [IMPORTS_FROM]
  2. src/lib/schemas.ts       [IMPORTS_FROM]
  3. src/lib/format.ts        [IMPORTS_FROM]
  4. packages/db/src/index.ts [IMPORTS_FROM]

SKIP: 1170 other files — not in blast radius
```

### CLI コマンド

| コマンド | 内容 |
|---|---|
| `npx ts-review-graph@latest install --tsconfig <path>` | セットアップ + 初回ビルド |
| `npx ts-review-graph build` | グラフを再構築（config.json 参照） |
| `npx ts-review-graph update <file>` | 単一ファイルを増分更新 |
| `npx ts-review-graph status` | グラフの統計を表示 |
| `npx ts-review-graph uninstall` | MCP 登録を解除 |

### MCP ツール一覧

| ツール | 主な引数 | 内容 |
|---|---|---|
| `get_minimal_context` | `changed_files[]`, `mode`（省略時: `"review"`） | 読むべき最小ファイルセット（REVERSE/FORWARD BFS） |
| `get_impact` | `changed_file` | 影響を受けるファイルと深さ |
| `get_type_usages` | `type_name` | 型を参照するノード一覧 |
| `get_test_coverage` | `file` | 対応するテストファイル一覧 |
| `query_graph` | `from`, `edge_kind`, `direction`, `depth` | 汎用グラフ探索 |
| `build_graph` | `tsconfigs` | グラフを再構築（`tsconfig` 単一形式は非推奨） |
| `graph_status` | — | グラフ統計を表示 |

### モード別 BFS 深さ

| mode | REVERSE | FORWARD | 用途 |
|---|---|---|---|
| `review` | depth=2 | なし | コードレビュー前の影響調査（downstream） |
| `implement` | depth=3 | 直接 import のみ（固定 depth=1） | 実装タスク前の変更候補特定（両方向） |
| `debug` | depth=5 | なし | バグ調査の広範な探索（upstream） |

## 設定ファイル

`.ts-review-graph/config.json`（`install` 時に自動生成、コミット推奨）:

```json
{
  "tsconfigs": [
    "apps/api/tsconfig.json",
    "apps/web/tsconfig.app.json",
    "apps/monitor-worker/tsconfig.json"
  ]
}
```

`graph.db` はビルド成果物のため `.gitignore` に追加されます（自動）。`config.json` はチームで共有してください。

## 仕組み

### グラフ構築フェーズ

1. 各 `tsconfig.json` を読み込み
2. TypeScript Compiler API で AST を走査
3. Import/Export/Type 定義関係を抽出
4. SQLite (graph.db) に nodes / edges を保存

### クエリフェーズ

1. 変更ファイル指定（`["src/routes/monitors.ts"]`）
2. 指定モードで BFS（幅優先探索）実行
   - REVERSE: このファイルを import している者（downstream）
   - FORWARD: このファイルが import している者（upstream）
3. blast radius 内のファイルのみ返す

## ベンチマーク

詳細は [BENCHMARK.md](./BENCHMARK.md) を参照。

### まとめ

| 指標 | ベースライン | ts-review-graph | 削減率 |
|---|---|---|---|
| Read ツール呼び出し | 14 回 | 3 回 | -79% |
| ファイルコンテンツバイト | 219,139 | 58,583 | -73% |
| 推定トークン数 | ~54,784 | ~14,645 | -73% |

**対象**: manako (Cloudflare Workers monorepo)  
**グラフサイズ**: 1,191 nodes / 1,400+ edges  
**テストケース**: `monitors.ts` に `isPaused` フラグ追加

## 技術スタック

- **Language**: TypeScript 5.4+
- **Database**: SQLite 3 (sql.js + better-sqlite3)
- **Graph Traversal**: SQL recursive CTE (WITH RECURSIVE)
- **MCP**: Model Context Protocol SDK v1.0.0
- **CLI**: Commander.js 12.0.0

## ライセンス

MIT

---

## パッケージ

| パッケージ | 説明 | Version |
|---|---|---|
| `ts-review-graph` | CLI ツール | 0.2.0 |
| `@ts-review-graph/mcp-server` | MCP サーバー | 0.2.0 |
| `@ts-review-graph/core` | グラフ構築・クエリエンジン | 0.2.0 |

## 関連リンク

- [BENCHMARK.md](./BENCHMARK.md) — 実測データ
- [docs/](./docs/) — 詳細ドキュメント（開発中）
