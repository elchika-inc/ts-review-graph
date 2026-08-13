# ts-review-graph

## Commands

```bash
pnpm build          # 全パッケージをビルド (tsc)
pnpm test           # 全パッケージのテストを実行 (vitest)
pnpm lint           # 全パッケージの型チェック (tsc --noEmit)
pnpm sync-version   # cli/package.json の version を全配布物へ同期

# 特定パッケージのみ
cd packages/core && pnpm build
cd packages/mcp-server && pnpm build
cd cli && pnpm build
```

## Architecture

pnpm monorepo。4 パッケージで構成:

| Package | Name | Role |
|---------|------|------|
| `packages/core` | `@elchika-inc/ts-review-graph-core` | グラフ構築・クエリエンジン (SQLite + ts-morph) |
| `packages/mcp-server` | `@elchika-inc/ts-review-graph-mcp-server` | MCP サーバー (8 ツール) |
| `packages/plugin` | (配布専用) | Claude Code プラグイン (commands/hooks/skills) |
| `cli/` | `@elchika-inc/ts-review-graph` | CLI ツール |

依存関係: `mcp-server` → `core`、`cli` → `core`。`plugin` は Node package/build を持たず、Markdown・`hooks.json`・shell hook scripts で構成する。

## Key Files

- `packages/core/src/db.ts` — SQLite スキーマ定義と `openDb`
- `packages/core/src/analyzer.ts` — ts-morph による AST 解析
- `packages/core/src/blast.ts` — BFS ブラスト半径計算 (SQL Recursive CTE)
- `packages/core/src/updater.ts` — 増分更新ロジック
- `packages/mcp-server/src/tools/index.ts` — 全 MCP ツール定義と登録
- `cli/src/index.ts` — CLI エントリポイント (install/build/update/status/uninstall)

## Database Schema

SQLite 4 テーブル: `nodes`、`edges`、`file_hashes`、`meta`

Edge kinds: `IMPORTS_FROM` | `TYPED_BY` | `IMPLEMENTS` | `EXTENDS` | `HAS_TEST`

**重要**: `nodes.file` と `nodes.id` はプロジェクトルート相対の POSIX パスで保存する。
絶対パスで保存すると、リポジトリの移動・worktree・別マシンでのクローンでグラフが
無言で全件ミスする（実障害あり）。DB へ保存するすべてのファイルパスは共通
ユーティリティ `toProjectRelative` を通す。`analyzer.ts` ではルート外を除外する
`toRelativeOrNull` を経由する。

**重要**: `edges.target_id` に意図的に REFERENCES を付けていない。増分更新でファイルを
削除するとき、`source_id` が削除ファイルのエッジだけを CASCADE で消し、
逆方向 (`B→A`) エッジは残す必要があるため。

**重要**: `meta` テーブルはグラフの構築条件（`schema_version` / `tsconfigs` /
`built_at` / `built_root`）を記録する。`checkGraphHealth()` がこれを使って検疫する。
`meta` 不在の DB は旧形式として fail-closed で拒否される。

**重要**: Node ABI 不一致の診断 (`formatNpxAbiMismatchGuidance`) は `packages/core/src/diagnostics.ts`
が正本で、CLI (`install`/`build`/`update`/`status`) と MCP サーバーの degraded mode の
**両方から参照する共通実装**。片側にだけ診断があると、同じ ABI 不一致が経路によって
「原因不明のグラフ未構築」に見える（実障害あり）。実装を複製せず core に置くこと。
`cli/tests/fixtures/abi-core.mjs` は core モジュールを差し替える loader stub だが、
診断関数だけは本物を再エクスポートしている（stub 化するとテストが空洞になる）。

**重要**: MCP サーバーは `db` が null のとき「DB ファイルが無い（未構築）」と
「DB を開けなかった」を区別して返す。区別の状態は `server.ts` の `dbFailure` が持ち、
`build_graph` 後の再オープン成否で更新される。`graph_status` は null チェックの免除対象
なので、共通分岐だけでなく `graphStatus` にも理由を明示的に渡す必要がある。

## Gotchas

- **ESM**: 全パッケージ `"type": "module"`。import パスは `.js` 拡張子必須 (TypeScript でも `import ... from './foo.js'`)
- **workspace:***: パッケージ間依存は `"workspace:*"` で指定。publish 前に `pnpm publish` で自動解決される
- **Node.js 20+**: `better-sqlite3` のネイティブビルドに必要
- **公開物は lockstep version**: core・MCP server・CLI・Claude Code plugin は同一 version で公開する。`cli/package.json` を version の正本とし、`pnpm sync-version` で他の package と plugin 配布物へ同期する。一致テストも残し、同期漏れを検出する。CLI の `install` は CLI 自身の version で `.mcp.json` の MCP server を固定する
- **SQLite DB は .gitignore**: `graph.db`・`graph.db-wal`・`graph.db-shm` はビルドアーティファクト。`config.json` だけコミットする

## Release

1. `cli/package.json` の `version` を上げる
2. `pnpm sync-version` を実行する
3. `pnpm build`、`pnpm test`、`pnpm lint` を実行する
4. 変更をコミットして push する
5. `pnpm publish -r --access public` を実行する
6. 導入済みリポジトリで、公開した新 version の CLI に初回と同じ `--tsconfig` / `--db` を指定して `install` を再実行し、`.mcp.json` を更新する

## Plugin Structure

`packages/plugin/` は Claude Code プラグイン配布用ディレクトリ (package.json なし):
- `commands/` — スラッシュコマンド (build.md / impact.md / review.md / status.md)
- `hooks/hooks.json` — PreToolUse (Read), PostToolUse (Write/Edit) フック
- `skills/ts-review-graph/SKILL.md` — スキル定義

## Testing

各パッケージに vitest テストがある。テスト追加時は対象パッケージの `tests/` に配置する。
MCP のインテグレーションテストは `packages/mcp-server/tests/` に配置する。

## TypeScript Dependency Graph (ts-review-graph MCP)

### 必須: ソースコード参照前にコンテキスト取得

コードレビュー・実装・デバッグで**ソースファイルを Read する前に**、必ず `get_minimal_context` を呼び出すこと。

```
mcp__ts-review-graph__get_minimal_context({
  changed_files: ["src/foo.ts"],
  mode: "review"   // review | implement | debug
})
```

| mode | 使う場面 |
|------|---------|
| `review` | PR レビュー、コード調査 — REVERSE BFS (影響範囲) を返す |
| `implement` | 新機能実装 — REVERSE + 深さ1 FORWARD (依存先) を返す |
| `debug` | バグ調査 — REVERSE BFS (影響範囲) を返す |

グラフが古い場合は `mcp__ts-review-graph__build_graph` で再構築する。
