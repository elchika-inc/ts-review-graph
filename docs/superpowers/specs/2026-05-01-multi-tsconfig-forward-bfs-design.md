# ts-review-graph v0.2 設計仕様

**作成日**: 2026-05-01  
**ステータス**: 承認済み  
**対象バージョン**: 0.2.0

---

## 背景と動機

BENCHMARK.md の効果測定で明らかになった2つの制約を解消する:

1. **スコープが狭い**: `apps/api` のみ対象（`apps/web` 非対象）→ フルスタック変更タスクで Web 層の探索が手動になる
2. **REVERSE BFS のみ**: `get_minimal_context` が「誰が依存しているか」しか返さない → 実装タスクで「何と一緒に変えるべきか」が分からない

---

## 変更サマリー

| 変更 | 内容 |
|---|---|
| 設定ファイル追加 | `.ts-review-graph/config.json` で複数 tsconfig を管理 |
| gitignore 変更 | `.ts-review-graph/` → `.ts-review-graph/graph.db` のみ除外 |
| CLI 変更 | `install`/`build` が config.json を参照・生成 |
| Core 変更 | 複数 tsconfig のグラフをマージしてビルド |
| blast.ts 変更 | FORWARD depth=1 クエリを追加 |
| MCP ツール変更 | `get_minimal_context` の implement モードで FORWARD を追加 |

---

## 1. 設定ファイル仕様

### ファイルパス

`.ts-review-graph/config.json`（プロジェクトルート起点）

### スキーマ

```typescript
interface TsReviewGraphConfig {
  // 対象 tsconfig.json のパス一覧（プロジェクトルート相対）
  tsconfigs: string[];
}
```

### 例（manako モノレポ）

```json
{
  "tsconfigs": [
    "apps/api/tsconfig.json",
    "apps/web/tsconfig.json",
    "apps/monitor-worker/tsconfig.json"
  ]
}
```

### 後方互換性

`config.json` が存在しない場合は `process.cwd()/tsconfig.json` にフォールバック。v0.1 利用者は何もしなくても動き続ける。

---

## 2. .gitignore 変更

### install 時の書き込み内容を変更

```gitignore
# before (v0.1)
# ts-review-graph
.ts-review-graph/

# after (v0.2)
# ts-review-graph (graph.db はビルド成果物、config.json はコミット対象)
.ts-review-graph/graph.db
```

`config.json` はチーム共有の設定ファイルのためコミット対象とする。

---

## 3. CLI 変更

### `install` コマンド

```bash
# 単一 tsconfig（v0.1 互換）
ts-review-graph install --tsconfig apps/api/tsconfig.json

# 複数 tsconfig（v0.2 新機能）
ts-review-graph install \
  --tsconfig apps/api/tsconfig.json \
  --tsconfig apps/web/tsconfig.json \
  --tsconfig apps/monitor-worker/tsconfig.json
```

動作:
1. `.ts-review-graph/config.json` に tsconfigs を書き込む
2. `.gitignore` を `graph.db` のみ除外に変更
3. 全 tsconfig を対象に初回フルビルド実行

### `build` コマンド

```bash
# config.json を自動参照（引数不要）
ts-review-graph build

# --tsconfig で上書き（デバッグ用）
ts-review-graph build --tsconfig apps/api/tsconfig.json
```

config.json が存在すれば tsconfigs 全件をビルド、なければ v0.1 と同じ動作。

### `update` コマンド

変更なし（単一ファイルの増分更新）。tsconfig は不要なため影響なし。

---

## 4. Core 変更 (`buildFullGraph`)

### シグネチャ変更

```typescript
// v0.1
export function buildFullGraph(db: Db, tsconfigPath: string): void

// v0.2
export function buildFullGraph(db: Db, tsconfigPaths: string[]): void
```

### 実装方針

- `analyzeProject()` を tsconfig ごとに呼び出し、結果をマージ
- ノード: `INSERT OR REPLACE` — 同一ファイルが複数 tsconfig に含まれても重複しない
- エッジ: `INSERT OR IGNORE` — PRIMARY KEY (source_id, target_id, kind) で自動排除
- 全 tsconfig のビルド完了後にトランザクションをコミット（アトミック）

### 後方互換性

呼び出し側の `buildFullGraph(db, path)` → `buildFullGraph(db, [path])` への変換は
CLI 側で行う。Core の public API は配列に統一。

---

## 5. FORWARD BFS 追加 (`blast.ts`)

### 新関数

```typescript
// 深さ1の前方探索: changed_file が直接 import しているファイル
export function computeForwardDeps(db: Db, changedFile: string): BlastNode[]
```

### SQL

```sql
SELECT DISTINCT n.file, 'direct import' as reason, 1 as depth
FROM nodes src
JOIN edges e ON e.source_id = src.id
  AND e.kind = 'IMPORTS_FROM'
JOIN nodes n ON n.id = e.target_id
WHERE src.file = :changed_file
  AND n.file != :changed_file
```

### depth=1 の根拠

- depth=2 以上は「型定義ファイル → drizzle-orm」のような外部パッケージ境界を越えるリスクがある
- 実装タスクで「一緒に変えるべきファイル」の 80% は直接 import 先に収まる
- 外部パッケージは `node_modules` を含むため、既存の `!targetFile.includes("node_modules")` フィルタで自動排除される

---

## 6. `get_minimal_context` 出力変更

### implement モードのみ変更

`review` / `debug` モードは REVERSE のみ（現状維持）。

### 新しい出力フォーマット（implement モード）

```
Changed: apps/api/src/routes/monitors.ts

── 影響を受けるファイル（REVERSE depth=3） ──
  1. apps/api/src/routes/services.ts   [IMPORTS_FROM]
  2. apps/api/src/index.ts             [IMPORTS_FROM]

── 一緒に変えるべきファイル（FORWARD depth=1） ──
  1. packages/db/src/schema.ts         [direct import]
  2. apps/api/src/lib/schemas.ts       [direct import]
  3. apps/api/src/lib/format.ts        [direct import]
  4. apps/monitor-worker/src/scheduler.ts  [direct import]
  5. apps/web/src/lib/api.ts           [direct import]

SKIP: 133 other files — not in blast radius
```

### FORWARD が空の場合

```
── 一緒に変えるべきファイル（FORWARD depth=1） ──
  (なし — 他パッケージへの直接依存なし)
```

---

## 7. 変更対象ファイル一覧

| ファイル | 変更種別 |
|---|---|
| `cli/src/index.ts` | 修正（install/build コマンド拡張、config.json 読み書き追加） |
| `packages/core/src/updater.ts` | 修正（`buildFullGraph` シグネチャ変更、複数 tsconfig マージ） |
| `packages/core/src/blast.ts` | 修正（`computeForwardDeps` 追加） |
| `packages/core/src/index.ts` | 修正（`computeForwardDeps` export 追加） |
| `packages/mcp-server/src/tools/get-minimal-context.ts` | 修正（implement モードで FORWARD 追加） |
| `packages/core/tests/blast.test.ts` | 修正（`computeForwardDeps` テスト追加） |
| `packages/mcp-server/tests/tools.test.ts` | 修正（implement モード出力テスト更新） |
| `BENCHMARK.md` | 更新（v0.2 の理論値を追記） |
| `README.md` | 新規（OSS 向けドキュメント） |

---

## 8. バージョニング方針

- 本変更は `0.2.0`（MINOR bump）
- `buildFullGraph` の引数変更は破壊的変更だが、v0.1 は未公開のため問題なし
- CLI の `--tsconfig` オプションは後方互換を維持

---

## 成功基準

1. `ts-review-graph install --tsconfig apps/api/tsconfig.json --tsconfig apps/web/tsconfig.json` が config.json を生成してビルドできる
2. `ts-review-graph build`（引数なし）が config.json を参照して全 tsconfig をビルドする
3. manako で `get_minimal_context(["monitors.ts"], "implement")` を呼ぶと FORWARD に `schema.ts`, `web/api.ts` などが含まれる
4. `review` / `debug` モードの既存テストが全て通る
5. config.json なし環境（v0.1 互換）でも動作する
