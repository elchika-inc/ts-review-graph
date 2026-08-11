---
name: ts-review-graph:build
description: プロジェクトのグラフを手動で再構築する
---

Call the `build_graph` MCP tool from the `ts-review-graph` server.
If a tsconfig path is provided as argument, pass it as `tsconfigs: [<path>]`.
Display the result (node count, edge count, elapsed time).
