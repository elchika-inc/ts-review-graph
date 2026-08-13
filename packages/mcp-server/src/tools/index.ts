import { checkGraphHealth } from "@elchika-inc/ts-review-graph-core";
import type { Db } from "@elchika-inc/ts-review-graph-core";
import { getMinimalContext } from "./get-minimal-context.js";
import { getImpact } from "./get-impact.js";
import { getTypeUsages } from "./get-type-usages.js";
import { getTestCoverage } from "./get-test-coverage.js";
import { queryGraph } from "./query-graph.js";
import { buildGraph } from "./build-graph.js";
import { graphStatus } from "./graph-status.js";
import { findCycles } from "./find-cycles.js";
import { formatDbUnavailableText, type DbOpenFailure } from "./db-unavailable.js";
import type { ToolResult } from "./types.js";

export type { DbOpenFailure } from "./db-unavailable.js";

function getProjectRoot(): string {
  return process.cwd();
}

// 検疫の対象外 — build_graph は復旧手段そのもの、graph_status は診断表示のため
const QUARANTINE_EXEMPT = new Set(["build_graph", "graph_status"]);

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
          description: "List of files you plan to change (max 100)",
          minItems: 1,
          maxItems: 100,
        },
        mode: {
          type: "string",
          enum: ["review", "implement", "debug"],
          default: "review",
          description: "review=check impact (default), implement=plan changes across layers, debug=deep trace",
        },
      },
      required: ["changed_files"],
    },
  },
  {
    name: "get_impact",
    description:
      "Return all files that depend on the given file, with the dependency reason (IMPORTS_FROM, TYPED_BY, etc.) and depth. " +
      "Traverses up to depth 5. For a single file, prefer get_minimal_context with mode='review' for mode-aware filtering. " +
      "Use get_impact only when you need the raw full list with per-file depth labels. " +
      "変更ファイルに依存するファイル一覧と依存理由・深さを返す（最大depth=5）。",
    inputSchema: {
      type: "object" as const,
      properties: {
        changed_file: { type: "string", description: "Absolute or project-root-relative file path" },
        format: {
          type: "string",
          enum: ["text", "mermaid"],
          default: "text",
          description: "text=current detailed list (default), mermaid=GitHub-renderable dependency graph",
        },
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
      "General-purpose graph traversal. Explore the dependency graph starting from a file path in forward or reverse direction. " +
      "Returns up to 200 results. グラフをパラメータ化クエリで探索する（汎用）。",
    inputSchema: {
      type: "object" as const,
      properties: {
        from: { type: "string", description: "Starting file path (absolute or project-root-relative)" },
        edge_kind: {
          type: "string",
          enum: ["IMPORTS_FROM", "TYPED_BY", "IMPLEMENTS", "EXTENDS", "HAS_TEST"],
          description: "Filter by edge type (omit to include all). Note: HAS_TEST is forward-only (use get_test_coverage for that)",
        },
        direction: {
          type: "string",
          enum: ["forward", "reverse"],
          description: "forward=who this file depends on, reverse=who depends on this file",
        },
        depth: { type: "number", description: "Traversal depth limit", default: 3, minimum: 1, maximum: 10 },
      },
      required: ["from"],
    },
  },
  {
    name: "find_cycles",
    description:
      "Find file-level circular dependencies across IMPORTS_FROM edges. " +
      "Rotations of the same directed cycle are returned once. " +
      "IMPORTS_FROMエッジ上のファイル単位の循環依存を検出する。",
    inputSchema: {
      type: "object" as const,
      properties: {
        max_cycles: {
          type: "number",
          default: 20,
          minimum: 1,
          maximum: 100,
          description: "Maximum number of cycles to return (default: 20)",
        },
      },
      required: [],
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
      },
      required: [],
    },
  },
  {
    name: "graph_status",
    description:
      "Return graph statistics: node count, edge count, file count, and last build time. " +
      "Output format: plain text with fields nodes, edges, files, updated_at (ISO 8601). " +
      "Use to verify the graph is built before calling other tools. " +
      "グラフの統計情報（ノード数・エッジ数・最終更新）を返す。",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

export function registerTools(
  db: Db | null,
  toolName: string,
  args: Record<string, unknown>,
  dbFailure: DbOpenFailure | null = null
): ToolResult {
  // graph_status と build_graph は db=null でも動作する（build_graph は復旧手段そのもの）
  if (!db && toolName !== "build_graph" && toolName !== "graph_status") {
    return {
      content: [{ type: "text", text: formatDbUnavailableText(dbFailure) }],
      isError: true,
    };
  }

  let staleNotice: string | null = null;

  if (db && !QUARANTINE_EXEMPT.has(toolName)) {
    let health: ReturnType<typeof checkGraphHealth>;
    try {
      health = checkGraphHealth(db, getProjectRoot());
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `✗ GRAPH HEALTH CHECK FAILED — 結果を返しません (${err instanceof Error ? err.message : String(err)})`,
        }],
        isError: true,
      };
    }
    if (health.status === "mismatch") {
      return {
        content: [{
          type: "text",
          text: [
            `✗ GRAPH MISMATCH — 結果を返しません (${health.reason})`,
            `  ${health.detail}`,
            "  → build_graph ツールを実行してグラフを再構築してください。",
          ].join("\n"),
        }],
        isError: true,
      };
    }
    if (health.status === "drift") {
      staleNotice = `⚠ STALE: ${health.staleFiles} files changed since graph build (${health.totalFiles} total)`;
    }
  }

  const result = dispatch(db, toolName, args, dbFailure);

  if (staleNotice && result.isError !== true && result.content[0]?.type === "text") {
    result.content[0].text = `${staleNotice}\n\n${result.content[0].text}`;
  }
  return result;
}

function dispatch(
  db: Db | null,
  toolName: string,
  args: Record<string, unknown>,
  dbFailure: DbOpenFailure | null
): ToolResult {
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
    case "find_cycles":
      return findCycles(db!, args);
    case "build_graph":
      return buildGraph(args);
    case "graph_status":
      return graphStatus(db, dbFailure, getProjectRoot());
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
  }
}
