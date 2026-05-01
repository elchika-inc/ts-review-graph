# ts-review-graph 効果測定 — isPaused フラグ実装タスクによるトークン比較

**測定日**: 2026-05-01  
**対象プロジェクト**: [manako](https://github.com/elchika-inc/manako-dev) (Cloudflare Workers monorepo)  
**グラフ**: 606 nodes / 752 edges (apps/api + packages + apps/monitor-worker)  
**タスク**: `monitors.ts` に `isPaused` フラグを追加する変更ファイルの洗い出し

---

## 測定条件

| | Session A | Session B |
|---|---|---|
| ts-review-graph | **無効** | **有効** |
| 探索方法 | Read ツールで手動探索 | `get_minimal_context` → 指示されたファイルのみ Read |
| プロンプト | 同一 (`monitors.ts に isPaused フラグを追加するタスク...`) | 同一 |

---

## 結果

### Session A: 手動探索（ベースライン）

**Read ツール呼び出し: 14 回**

| # | ファイル | バイト数 |
|---|---|---|
| 1 | `apps/api/src/routes/monitors.ts` | 30,472 |
| 2 | `packages/db/src/schema.ts` | 22,523 |
| 3 | `packages/api-client/src/client.ts` | 10,851 |
| 4 | `packages/shared/src/types/monitor.ts` | 2,199 |
| 5 | `apps/web/src/components/monitors/MonitorList.tsx` | 2,915 |
| 6 | `apps/web/src/pages/MonitorDetail.tsx` | 37,929 |
| 7 | `apps/api/src/lib/schemas.ts` | 1,454 |
| 8 | `apps/api/src/routes/maintenance.ts` | 4,917 |
| 9 | `apps/api/src/lib/format.ts` | 1,528 |
| 10 | `apps/web/src/lib/api.ts` | 33,997 |
| 11 | `apps/api/src/lib/check-executor.ts` | 3,524 |
| 12 | `apps/monitor-worker/src/scheduler.ts` | 3,035 |
| 13 | `apps/web/src/components/monitors/MonitorForm.tsx` | 19,792 |
| 14 | `apps/api/src/routes/public-api.ts` | 44,003 |
| **合計** | | **219,139 bytes** |

**推定ファイルコンテンツトークン: ~54,784**  
**発見した変更必要ファイル数: 9**（DB/API/Worker/Web 全層を網羅）

---

### Session B: ts-review-graph 使用

`get_minimal_context(["apps/api/src/routes/monitors.ts"], "implement")` の実行結果:

```
Changed: apps/api/src/routes/monitors.ts

READ THESE FILES ONLY (3 files, mode=implement, depth=3):
  1. apps/api/src/routes/monitors.ts      [changed]
  2. apps/api/src/routes/services.ts      [IMPORTS_FROM]
  3. apps/api/src/index.ts                [IMPORTS_FROM]

SKIP: 137 other files — not in blast radius
```

**Read ツール呼び出し: 3 回**（blast radius のみ）

| # | ファイル | バイト数 |
|---|---|---|
| 1 | `apps/api/src/routes/monitors.ts` | 30,472 |
| 2 | `apps/api/src/routes/services.ts` | 16,858 |
| 3 | `apps/api/src/index.ts` | 11,253 |
| **合計** | | **58,583 bytes** |

**推定ファイルコンテンツトークン: ~14,645**

---

## 比較

| 指標 | Session A (ベースライン) | Session B (ts-review-graph) | 削減率 |
|---|---|---|---|
| Read ツール呼び出し回数 | **14** | **3** | **-79%** |
| 読んだファイルのバイト数 | 219,139 | 58,583 | **-73%** |
| 推定ファイルコンテンツトークン | ~54,784 | ~14,645 | **-73%** |
| 変更必要ファイルの発見数 | 9 (全層) | 3 のみ（不完全） | — |

---

## 重要な気づき

### ✅ ts-review-graph が有効なケース

**コードレビュー・影響範囲確認**（`mode=review`）において効果的:
- 「この変更で何が壊れるか？」= REVERSE BFS で downstream を特定
- 無関係なファイルを大量に読む無駄を防ぐ
- Read 回数を最大 79% 削減（今回の測定）

### ⚠️ 現在の制約

**1. 対象スコープが限定**
| 対象 | カバー |
|---|---|
| `apps/api` | ✅ 362 nodes |
| `packages` | ✅ 208 nodes |
| `apps/monitor-worker` | ✅ 36 nodes |
| `apps/web` (フロントエンド) | ❌ 0 nodes |
| `apps/mcp-server` | ❌ 0 nodes |
| `apps/cli` | ❌ 0 nodes |

フルスタック変更タスクでは Web 層の探索は依然として手動が必要。

**2. REVERSE BFS のみで「実装タスク」に不完全**

`get_minimal_context` は「monitors.ts を変更したとき誰が影響を受けるか」（downstream）を返す。  
しかし実装タスクでは「monitors.ts が依存している何を一緒に変更すべきか」（upstream）も必要:

- Session B が返した: `services.ts`, `index.ts` (monitors.ts を import しているファイル)
- Session B が**返さなかった**: `schema.ts`, `schemas.ts`, `scheduler.ts`, `api-client/client.ts`, `web/api.ts` (monitors.ts が依存しており、一緒に変更が必要なファイル)

### 💡 改善案

実装タスク向けに FORWARD 方向のトラバーサルも追加することで、  
「変更対象ファイルの依存先（共変更候補）」も返せるようになる:

```sql
-- 追加: FORWARD BFS (monitors.ts が import しているもの)
WITH RECURSIVE forward_blast AS (
  SELECT target_id, 1 as depth
  FROM edges
  WHERE source_id IN (SELECT id FROM nodes WHERE file = :changed_file)
    AND kind IN ('IMPORTS_FROM', 'TYPED_BY')
  -- depth <= 1 に制限（深すぎると全ファイルになる）
)
```

---

## 結論

| | 結果 |
|---|---|
| **Read 回数削減** | -79%（14回 → 3回） |
| **ファイルコンテンツトークン削減** | -73%（~54,784 → ~14,645） |
| **実装タスクの完全性** | ❌ apps/web 非対象 + upstream 依存を返さない |
| **コードレビュータスクの完全性** | ✅ downstream 影響ファイルを正確に特定 |

**推奨**: コードレビュー・影響範囲確認では即効性あり。実装タスクでは apps/web のグラフ化と FORWARD 方向 BFS の追加が次の改善ポイント。
