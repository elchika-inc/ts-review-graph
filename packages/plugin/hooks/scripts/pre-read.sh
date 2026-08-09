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

PROJECT_ROOT="$(pwd)"

# --- 検疫: schema_version が一致しないグラフは使わない ---
if ! META_EXISTS="$(sqlite3 "$DB_PATH" "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'" 2>&1)"; then
  echo "[ts-review-graph] グラフ検査に失敗しました: $META_EXISTS" >&2
  exit 0
fi
if [ "$META_EXISTS" != "1" ]; then
  echo "[ts-review-graph] グラフが旧形式です (schema_version=なし, 期待値 ${SCHEMA_VERSION})"
  echo "  → build_graph MCP ツールを実行して再構築してください。ブラスト半径は表示しません。"
  exit 0
fi
if ! DB_VERSION="$(sqlite3 "$DB_PATH" "SELECT value FROM meta WHERE key = 'schema_version'" 2>&1)"; then
  echo "[ts-review-graph] グラフ検査に失敗しました: $DB_VERSION" >&2
  exit 0
fi
if [ "$DB_VERSION" != "$SCHEMA_VERSION" ]; then
  echo "[ts-review-graph] グラフが旧形式です (schema_version=${DB_VERSION:-なし}, 期待値 ${SCHEMA_VERSION})"
  echo "  → build_graph MCP ツールを実行して再構築してください。ブラスト半径は表示しません。"
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

if ! RESULT="$(sqlite3 "$DB_PATH" "
  WITH RECURSIVE blast(node_id, depth, reason) AS (
    SELECT id, 0, 'changed' FROM nodes WHERE file = '${SAFE_PATH}'
    UNION ALL
    SELECT e.source_id, b.depth + 1, e.kind
    FROM blast b JOIN edges e ON e.target_id = b.node_id
    WHERE b.depth < 2
      AND e.kind IN ('IMPORTS_FROM', 'TYPED_BY', 'IMPLEMENTS', 'EXTENDS')
  ),
  ranked AS (
    SELECT n.file, b.reason, b.depth,
      ROW_NUMBER() OVER (PARTITION BY n.file ORDER BY b.depth, b.reason) AS row_num
    FROM blast b JOIN nodes n ON n.id = b.node_id
  )
  SELECT file, reason FROM ranked WHERE row_num = 1
  ORDER BY depth, file
  LIMIT 21
" 2>&1)"; then
  echo "[ts-review-graph] ブラスト半径の照会に失敗しました: $RESULT" >&2
  exit 0
fi

if [ -z "$RESULT" ]; then
  exit 0
fi

echo "[ts-review-graph] Blast radius for: $REL_PATH"
RESULT_COUNT="$(printf '%s\n' "$RESULT" | awk 'NF { count++ } END { print count + 0 }')"
TRUNCATED=0
if [ "$RESULT_COUNT" -gt 20 ]; then
  TRUNCATED=1
  RESULT="$(printf '%s\n' "$RESULT" | sed -n '1,20p')"
  echo "BLAST RADIUS TRUNCATED: more than 20 files. This list is not complete."
  echo "SUGGESTED FILES (partial):"
else
  echo "READ THESE FILES ONLY:"
fi
while IFS='|' read -r file reason; do
  echo "  $file  [$reason]"
done <<< "$RESULT"
if [ "$TRUNCATED" -eq 1 ]; then
  echo "Run the MCP query for the complete blast radius; do not skip files based on this partial list."
else
  echo "SKIP all other files — not in blast radius."
fi
