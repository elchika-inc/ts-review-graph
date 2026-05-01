import { openDb, buildFullGraph } from "@ts-review-graph/core";
import path from "node:path";
import { existsSync } from "node:fs";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function buildGraph(args: Record<string, unknown>): ToolResult {
  const tsconfigPath =
    (args["tsconfig"] as string | undefined) ??
    path.join(process.cwd(), "tsconfig.json");

  if (!existsSync(tsconfigPath)) {
    return {
      content: [
        {
          type: "text",
          text: `tsconfig.json が見つかりません: ${tsconfigPath}`,
        },
      ],
    };
  }

  const dbPath =
    process.env["TS_REVIEW_GRAPH_DB"] ??
    path.join(process.cwd(), ".ts-review-graph/graph.db");
  const db = openDb(dbPath);

  try {
    const startMs = Date.now();
    buildFullGraph(db, tsconfigPath);
    const elapsed = Date.now() - startMs;

    const { nodeCount } = db
      .prepare("SELECT COUNT(*) as nodeCount FROM nodes")
      .get() as { nodeCount: number };
    const { edgeCount } = db
      .prepare("SELECT COUNT(*) as edgeCount FROM edges")
      .get() as { edgeCount: number };

    return {
      content: [
        {
          type: "text",
          text: `グラフ構築完了: ${nodeCount} nodes, ${edgeCount} edges (${elapsed}ms)`,
        },
      ],
    };
  } finally {
    db.close();
  }
}
