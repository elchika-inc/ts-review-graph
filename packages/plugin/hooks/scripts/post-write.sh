#!/usr/bin/env bash
# PostToolUse(Write|Edit): 変更ファイルのグラフを増分更新する

set -euo pipefail

DB_PATH="${TS_REVIEW_GRAPH_DB:-$(pwd)/.ts-review-graph/graph.db}"
FILE_PATH="${CLAUDE_TOOL_INPUT_FILE_PATH:-${CLAUDE_TOOL_INPUT_PATH:-}}"

if [ -z "$FILE_PATH" ] || [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# .ts / .tsx ファイルのみ更新
if [[ "$FILE_PATH" != *.ts ]] && [[ "$FILE_PATH" != *.tsx ]]; then
  exit 0
fi

# ts-review-graph CLI で増分更新
npx ts-review-graph update "$FILE_PATH" --db "$DB_PATH" 2>/dev/null || true
