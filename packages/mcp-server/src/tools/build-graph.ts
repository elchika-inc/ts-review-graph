import { openDb, buildFullGraph } from "@ts-review-graph/core";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function loadTsconfigPaths(cwd: string, argTsconfig?: string): string[] {
  // 1. Explicit arg
  if (argTsconfig) {
    return [argTsconfig];
  }

  // 2. config.json in .ts-review-graph/
  const configFile = path.join(cwd, ".ts-review-graph/config.json");
  if (existsSync(configFile)) {
    const cfg = JSON.parse(readFileSync(configFile, "utf-8")) as {
      tsconfigs?: string[];
    };
    if (cfg.tsconfigs && cfg.tsconfigs.length > 0) {
      return cfg.tsconfigs.map((p) =>
        path.isAbsolute(p) ? p : path.join(cwd, p)
      );
    }
  }

  // 3. Fallback to root tsconfig.json
  return [path.join(cwd, "tsconfig.json")];
}

export function buildGraph(args: Record<string, unknown>): ToolResult {
  const cwd = process.cwd();
  const tsconfigPaths = loadTsconfigPaths(
    cwd,
    args["tsconfig"] as string | undefined
  );

  const missing = tsconfigPaths.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    return {
      content: [
        {
          type: "text",
          text: `tsconfig.json が見つかりません: ${missing.join(", ")}`,
        },
      ],
    };
  }

  const dbPath =
    process.env["TS_REVIEW_GRAPH_DB"] ??
    path.join(cwd, ".ts-review-graph/graph.db");
  const db = openDb(dbPath);

  try {
    const startMs = Date.now();
    buildFullGraph(db, tsconfigPaths);
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
