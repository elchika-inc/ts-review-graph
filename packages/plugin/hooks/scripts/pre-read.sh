#!/usr/bin/env bash
# PreToolUse(Read): ブラスト半径をアドバイザリとして stdout に出力する
# 入力契約は packages/plugin/hooks/scripts/README.md に実測結果を記録している
# これはアドバイザリのみ: Claude を強制的に制約するものではない

set -euo pipefail

SCHEMA_VERSION="2"
DB_PATH="${TS_REVIEW_GRAPH_DB:-$(pwd)/.ts-review-graph/graph.db}"

# --- ファイルパスの取得（Task 10 の実測結果） ---
INPUT_JSON="$(cat)"
FILE_PATH="$(printf '%s' "$INPUT_JSON" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

if [ -z "$FILE_PATH" ] || [ ! -f "$DB_PATH" ]; then
  exit 0
fi

PROJECT_ROOT="$(cd "$(dirname "$DB_PATH")/.." && pwd)"

# --- 検疫: schema_version が一致しないグラフは使わない ---
DB_VERSION="$(sqlite3 "$DB_PATH" "SELECT value FROM meta WHERE key = 'schema_version'" 2>/dev/null || true)"
if [ "$DB_VERSION" != "$SCHEMA_VERSION" ]; then
  echo "[ts-review-graph] グラフが旧形式です (schema_version=${DB_VERSION:-なし}, 期待値 ${SCHEMA_VERSION})"
  echo "  → ts-review-graph build を実行して再構築してください。ブラスト半径は表示しません。"
  exit 0
fi

# --- パスをプロジェクトルート相対へ正規化する ---
case "$FILE_PATH" in
  /*) REL_PATH="${FILE_PATH#"$PROJECT_ROOT"/}" ;;
  *)  REL_PATH="$FILE_PATH" ;;
esac
# ルート外だった場合（置換が起きず絶対パスのまま）は何もしない
case "$REL_PATH" in
  /*) exit 0 ;;
esac

# シングルクォートを SQL エスケープ（' → ''）してインジェクションを防ぐ
SAFE_PATH="${REL_PATH//\'/\'\'}"

RESULT=$(sqlite3 "$DB_PATH" "
  WITH RECURSIVE blast(node_id, depth, reason) AS (
    SELECT id, 0, 'changed' FROM nodes WHERE file = '${SAFE_PATH}'
    UNION ALL
    SELECT e.source_id, b.depth + 1, e.kind
    FROM blast b JOIN edges e ON e.target_id = b.node_id
    WHERE b.depth < 2
      AND e.kind IN ('IMPORTS_FROM', 'TYPED_BY', 'IMPLEMENTS', 'EXTENDS')
  )
  SELECT DISTINCT n.file, b.reason FROM blast b JOIN nodes n ON n.id = b.node_id
  ORDER BY b.depth, n.file
  LIMIT 20
" 2>/dev/null || true)

if [ -z "$RESULT" ]; then
  exit 0
fi

echo "[ts-review-graph] Blast radius for: $REL_PATH"
echo "READ THESE FILES ONLY:"
while IFS='|' read -r file reason; do
  echo "  $file  [$reason]"
done <<< "$RESULT"
echo "SKIP all other files — not in blast radius."
