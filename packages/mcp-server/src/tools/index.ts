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
    description: "変更ファイルのブラスト半径を計算し、Claude が読むべき最小ファイルセットを返す。コードレビュー・実装・デバッグ前に必ず呼ぶ。",
    inputSchema: {
      type: "object" as const,
      properties: {
        changed_files: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ["review", "implement", "debug"] },
      },
      required: ["changed_files", "mode"],
    },
  },
  {
    name: "get_impact",
    description: "変更ファイルに依存するファイル一覧と依存理由を返す。",
    inputSchema: {
      type: "object" as const,
      properties: { changed_file: { type: "string" } },
      required: ["changed_file"],
    },
  },
  {
    name: "get_type_usages",
    description: "型名を受け取り、その型を参照する全ノードを返す。",
    inputSchema: {
      type: "object" as const,
      properties: { type_name: { type: "string" } },
      required: ["type_name"],
    },
  },
  {
    name: "get_test_coverage",
    description: "ファイルパスに対応するテストファイル一覧を返す。",
    inputSchema: {
      type: "object" as const,
      properties: { file: { type: "string" } },
      required: ["file"],
    },
  },
  {
    name: "query_graph",
    description: "グラフをパラメータ化クエリで探索する（汎用）。",
    inputSchema: {
      type: "object" as const,
      properties: {
        from: { type: "string" },
        edge_kind: { type: "string" },
        direction: { type: "string", enum: ["forward", "reverse"] },
        depth: { type: "number" },
      },
      required: ["from"],
    },
  },
  {
    name: "build_graph",
    description: "プロジェクト全体のグラフを構築・再構築する。",
    inputSchema: {
      type: "object" as const,
      properties: { tsconfig: { type: "string" } },
    },
  },
  {
    name: "graph_status",
    description: "グラフの統計情報（ノード数・エッジ数・最終更新）を返す。",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function registerTools(
  db: Db | null,
  toolName: string,
  args: Record<string, unknown>
): ToolResult {
  if (!db && toolName !== "build_graph") {
    return {
      content: [
        {
          type: "text",
          text: "グラフが未構築です。まず `ts-review-graph install` を実行してください。",
        },
      ],
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
      return graphStatus(db!);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
      };
  }
}
