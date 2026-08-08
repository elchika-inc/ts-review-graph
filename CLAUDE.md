# ts-review-graph

## Commands

```bash
pnpm build          # 全パッケージをビルド (tsc)
pnpm test           # 全パッケージのテストを実行 (vitest)
pnpm lint           # 全パッケージの型チェック (tsc --noEmit)

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

依存関係: `mcp-server` → `core`、`cli` → `core`。`plugin` は pure markdown。

## Key Files

- `packages/core/src/db.ts` — SQLite スキーマ定義と `openDb`
- `packages/core/src/analyzer.ts` — ts-morph による AST 解析
- `packages/core/src/blast.ts` — BFS ブラスト半径計算 (SQL Recursive CTE)
- `packages/core/src/updater.ts` — 増分更新ロジック
- `packages/mcp-server/src/tools/index.ts` — 全 MCP ツール定義と登録
- `cli/src/index.ts` — CLI エントリポイント (install/build/update/status/uninstall)

## Database Schema

SQLite 3 テーブル: `nodes`、`edges`、`file_hashes`

Edge kinds: `IMPORTS_FROM` | `TYPED_BY` | `IMPLEMENTS` | `EXTENDS` | `HAS_TEST`

**重要**: `edges.target_id` に意図的に REFERENCES を付けていない。増分更新でファイルを削除するとき、
`source_id` が削除ファイルのエッジだけを CASCADE で消し、逆方向 (`B→A`) エッジは残す必要があるため。

## Gotchas

- **ESM**: 全パッケージ `"type": "module"`。import パスは `.js` 拡張子必須 (TypeScript でも `import ... from './foo.js'`)
- **workspace:***: パッケージ間依存は `"workspace:*"` で指定。publish 前に `pnpm publish` で自動解決される
- **Node.js 20+**: `better-sqlite3` のネイティブビルドに必要
- **graph.db は .gitignore**: ビルドアーティファクト。`config.json` だけコミットする

## Plugin Structure

`packages/plugin/` は Claude Code プラグイン配布用ディレクトリ (package.json なし):
- `commands/` — スラッシュコマンド (build.md / impact.md / review.md / status.md)
- `hooks/hooks.json` — PreToolUse (Read), PostToolUse (Write/Edit) フック
- `skills/ts-review-graph/SKILL.md` — スキル定義

## Testing

`packages/core` と `packages/mcp-server` に vitest テスト。`cli` は `--passWithNoTests`。
テスト追加時は `packages/mcp-server/tests/` にインテグレーションテストを配置する。
