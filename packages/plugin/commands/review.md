---
name: ts-review-graph:review
description: PR レビュー前にブラスト半径を計算し、読むべき最小ファイルセットを表示する
---

Call the `get_minimal_context` MCP tool from the `ts-review-graph` server with:
- `changed_files`: List the files changed (get from `git diff --name-only origin/main` or from context)
- `mode`: "review"

Display the result to the user and say: "Read only the listed files before starting review."
