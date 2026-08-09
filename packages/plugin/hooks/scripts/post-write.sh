#!/usr/bin/env bash
# PostToolUse(Write|Edit): 変更ファイルのグラフを増分更新する

set -euo pipefail

DB_PATH="${TS_REVIEW_GRAPH_DB:-$(pwd)/.ts-review-graph/graph.db}"
INPUT_JSON="$(cat)"
FILE_PATH="$(printf '%s' "$INPUT_JSON" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

if [ -z "$FILE_PATH" ] || [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# .ts / .tsx ファイルのみ更新
if [[ "$FILE_PATH" != *.ts ]] && [[ "$FILE_PATH" != *.tsx ]]; then
  exit 0
fi

# ts-review-graph CLI で増分更新。失敗は surface するが、advisory hook 自体は継続する。
if ! UPDATE_OUTPUT="$(npx ts-review-graph update "$FILE_PATH" --db "$DB_PATH" 2>&1)"; then
  echo "[ts-review-graph] 増分更新に失敗しました: $UPDATE_OUTPUT" >&2
  exit 0
fi
if [ -n "$UPDATE_OUTPUT" ]; then
  printf '%s\n' "$UPDATE_OUTPUT"
fi
