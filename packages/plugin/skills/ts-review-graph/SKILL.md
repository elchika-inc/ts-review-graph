---
name: ts-review-graph
description: TypeScript プロジェクトのコードレビュー・実装・デバッグ時に自動起動。変更ファイルのブラスト半径を計算し、Claude が読むべき最小ファイルセットを提示する。
version: 0.5.2
---

## When This Skill Activates

Activate when:
- User asks to review code in a TypeScript project
- User asks to implement a feature in a TypeScript project
- User mentions "PR review", "コードレビュー", "影響範囲", "blast radius"
- A file with `.ts` or `.tsx` extension is being discussed

## What To Do

1. Identify changed files (from context, git diff, or user message)
2. Determine mode: "review" (PR review) | "implement" (feature work) | "debug" (bug fix)
3. Call `get_minimal_context` MCP tool with the changed files and mode
4. Present the result to the user
5. Read ONLY the files listed in the result before proceeding

## Mode Selection Guide

| Situation | Mode |
|-----------|------|
| PR review, code review | review (depth=2) |
| Adding features, refactoring | implement (depth=3) |
| Debugging, tracing errors | debug (depth=5) |

## Example Output

```
Changed: apps/api/src/routes/monitors.ts

READ THESE FILES ONLY (4 files, mode=review, depth=2):
  1. apps/api/src/routes/monitors.ts          [changed]
  2. apps/api/src/lib/monitor-config.ts       [IMPORTS_FROM]
  3. packages/shared/src/types.ts             [TYPED_BY]
  4. apps/api/tests/monitors.test.ts          [HAS_TEST]

SKIP: 2,704 other files — not in blast radius
```

## Fallback

If the graph is not built (tool returns "未構築"), suggest running:
```
npx -y @elchika-inc/ts-review-graph@0.5.2 build
```
