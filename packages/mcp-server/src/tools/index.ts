import type { Db } from "@ts-review-graph/core";

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
    name: "get_callers",
    description: "関数の完全修飾名を受け取り、呼び出し元一覧を返す。",
    inputSchema: {
      type: "object" as const,
      properties: { function_id: { type: "string" } },
      required: ["function_id"],
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

function notReady(toolName: string): ToolResult {
  return {
    content: [{ type: "text", text: `Tool '${toolName}' is not yet implemented.` }],
  };
}

function dbRequired(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: "グラフが未構築です。まず `ts-review-graph install` を実行してください。",
      },
    ],
  };
}

export function registerTools(
  db: Db | null,
  toolName: string,
  args: Record<string, unknown>
): ToolResult {
  void args; // Task 7 で各ツール実装時に使用

  if (!db && toolName !== "build_graph") {
    return dbRequired();
  }

  switch (toolName) {
    case "get_minimal_context":
    case "get_impact":
    case "get_type_usages":
    case "get_callers":
    case "get_test_coverage":
    case "query_graph":
    case "build_graph":
    case "graph_status":
      return notReady(toolName);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
      };
  }
}
