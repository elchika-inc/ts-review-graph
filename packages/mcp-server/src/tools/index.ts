import type { Db } from "@ts-review-graph/core";
import { getMinimalContext } from "./get-minimal-context.js";
import { getImpact } from "./get-impact.js";
import { getTypeUsages } from "./get-type-usages.js";
import { getTestCoverage } from "./get-test-coverage.js";
import { queryGraph } from "./query-graph.js";
import { buildGraph } from "./build-graph.js";
import { graphStatus } from "./graph-status.js";

export const TOOL_DEFINITIONS = [
  {
    name: "get_minimal_context",
    description:
      "Calculate the blast radius of changed TypeScript files and return the minimal file set to read. " +
      "Call this BEFORE reading any source files when you need to understand the impact of changes. " +
      "mode='review': returns reverse dependencies (files that import the changed file). " +
      "mode='implement': also returns forward dependencies (files the changed file imports) — use this when planning a new feature or adding fields across layers. " +
      "mode='debug': deeper reverse traversal (depth=5) for tracing cascading failures. " +
      "変更ファイルのブラスト半径を計算し、読むべき最小ファイルセットを返す。ソースファイルを読む前に必ず呼ぶ。",
    inputSchema: {
      type: "object" as const,
      properties: {
        changed_files: {
          type: "array",
          items: { type: "string", description: "File path relative to project root or absolute path" },
          description: "List of files you plan to change",
        },
        mode: {
          type: "string",
          enum: ["review", "implement", "debug"],
          description: "review=check impact, implement=plan changes across layers, debug=deep trace",
        },
      },
      required: ["changed_files", "mode"],
    },
  },
  {
    name: "get_impact",
    description:
      "Return all files that depend on the given file, with the dependency reason (IMPORTS_FROM, TYPED_BY, etc.). " +
      "Use when you need the full dependency list without depth limits. " +
      "変更ファイルに依存するファイル一覧と依存理由を返す。",
    inputSchema: {
      type: "object" as const,
      properties: {
        changed_file: { type: "string", description: "Absolute or project-root-relative file path" },
      },
      required: ["changed_file"],
    },
  },
  {
    name: "get_type_usages",
    description:
      "Return all nodes (files/classes/functions) that reference the given TypeScript type name. " +
      "Useful for finding all callers before renaming or refactoring a type. " +
      "型名を受け取り、その型を参照する全ノードを返す。",
    inputSchema: {
      type: "object" as const,
      properties: {
        type_name: { type: "string", description: "TypeScript type or interface name to search for" },
      },
      required: ["type_name"],
    },
  },
  {
    name: "get_test_coverage",
    description:
      "Return test files associated with the given source file via HAS_TEST edges. " +
      "ファイルパスに対応するテストファイル一覧を返す。",
    inputSchema: {
      type: "object" as const,
      properties: {
        file: { type: "string", description: "Source file path to look up tests for" },
      },
      required: ["file"],
    },
  },
  {
    name: "query_graph",
    description:
      "General-purpose graph traversal. Explore the dependency graph starting from a file in forward or reverse direction. " +
      "グラフをパラメータ化クエリで探索する（汎用）。",
    inputSchema: {
      type: "object" as const,
      properties: {
        from: { type: "string", description: "Starting file path (absolute or project-root-relative)" },
        edge_kind: {
          type: "string",
          description: "Filter by edge type: IMPORTS_FROM | TYPED_BY | IMPLEMENTS | EXTENDS | HAS_TEST (omit to include all)",
        },
        direction: {
          type: "string",
          enum: ["forward", "reverse"],
          description: "forward=who this file depends on, reverse=who depends on this file",
        },
        depth: { type: "number", description: "Traversal depth limit (default: 3)" },
      },
      required: ["from"],
    },
  },
  {
    name: "build_graph",
    description:
      "Build or rebuild the TypeScript dependency graph for this project. " +
      "Run this once after project setup, and again when files are added or removed. " +
      "Reads tsconfig paths from .ts-review-graph/config.json if present, otherwise uses tsconfig.json. " +
      "プロジェクト全体のグラフを構築・再構築する。初回セットアップ時およびファイル追加・削除後に実行する。",
    inputSchema: {
      type: "object" as const,
      properties: {
        tsconfigs: {
          type: "array",
          items: { type: "string" },
          description: "Optional: list of tsconfig.json paths to build from (overrides config.json)",
        },
        tsconfig: {
          type: "string",
          description: "Optional: single tsconfig.json path (deprecated — use tsconfigs for multi-tsconfig projects)",
        },
      },
    },
  },
  {
    name: "graph_status",
    description:
      "Return graph statistics: node count, edge count, and last build time. " +
      "Use to verify the graph is built before calling other tools. " +
      "グラフの統計情報（ノード数・エッジ数・最終更新）を返す。",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function registerTools(
  db: Db | null,
  toolName: string,
  args: Record<string, unknown>
): ToolResult {
  // graph_status と build_graph は db=null でも動作する
  if (!db && toolName !== "build_graph" && toolName !== "graph_status") {
    return {
      content: [
        {
          type: "text",
          text: "グラフが未構築です。まず `build_graph` ツールを呼び出してグラフを構築してください。",
        },
      ],
      isError: true,
    };
  }

  switch (toolName) {
    case "get_minimal_context":
      return getMinimalContext(db!, args);
    case "get_impact":
      return getImpact(db!, args);
    case "get_type_usages":
      return getTypeUsages(db!, args);
    case "get_test_coverage":
      return getTestCoverage(db!, args);
    case "query_graph":
      return queryGraph(db!, args);
    case "build_graph":
      return buildGraph(args);
    case "graph_status":
      return graphStatus(db);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
  }
}
