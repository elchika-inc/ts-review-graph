#!/usr/bin/env bash
# PreToolUse(Read): ブラスト半径をアドバイザリとして stdout に出力する
# グラフ未構築時は何も出力しない（Read をそのまま通過させる）
# これはアドバイザリのみ: Claude を強制的に制約するものではない

set -euo pipefail

DB_PATH="${TS_REVIEW_GRAPH_DB:-$(pwd)/.ts-review-graph/graph.db}"
FILE_PATH="${CLAUDE_TOOL_INPUT_FILE_PATH:-}"

if [ -z "$FILE_PATH" ] || [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# SQLite から直接ブラスト半径を照会
RESULT=$(sqlite3 "$DB_PATH" "
  WITH RECURSIVE blast(node_id, depth, reason) AS (
    SELECT id, 0, 'changed' FROM nodes WHERE file = '${FILE_PATH}'
    UNION ALL
    SELECT e.source_id, b.depth + 1, e.kind
    FROM blast b JOIN edges e ON e.target_id = b.node_id
    WHERE b.depth < 2
      AND e.kind IN ('CALLS', 'IMPORTS_FROM', 'TYPED_BY', 'IMPLEMENTS', 'EXTENDS')
  )
  SELECT DISTINCT n.file, b.reason FROM blast b JOIN nodes n ON n.id = b.node_id
  ORDER BY b.depth, n.file
  LIMIT 20
" 2>/dev/null || true)

if [ -z "$RESULT" ]; then
  exit 0
fi

echo "[ts-review-graph] Blast radius for: $FILE_PATH"
echo "READ THESE FILES ONLY:"
while IFS='|' read -r file reason; do
  echo "  $file  [$reason]"
done <<< "$RESULT"
echo "SKIP all other files — not in blast radius."
