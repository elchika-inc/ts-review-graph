import { openDb, buildFullGraph } from "@elchika-inc/ts-review-graph-core";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { ToolResult } from "./types.js";

function loadTsconfigPaths(cwd: string, argTsconfigs?: string[]): string[] {
  // 1. Explicit arg(s)
  if (argTsconfigs && argTsconfigs.length > 0) {
    return argTsconfigs;
  }

  // 2. config.json in .ts-review-graph/
  const configFile = path.join(cwd, ".ts-review-graph/config.json");
  if (existsSync(configFile)) {
    let cfg: unknown;
    try {
      cfg = JSON.parse(readFileSync(configFile, "utf-8"));
    } catch {
      return [path.join(cwd, "tsconfig.json")];
    }
    if (
      cfg !== null &&
      typeof cfg === "object" &&
      "tsconfigs" in cfg &&
      Array.isArray((cfg as { tsconfigs: unknown }).tsconfigs) &&
      ((cfg as { tsconfigs: unknown[] }).tsconfigs).every((x) => typeof x === "string")
    ) {
      const tsconfigs = (cfg as { tsconfigs: string[] }).tsconfigs;
      if (tsconfigs.length > 0) {
        return tsconfigs.map((p) =>
          path.isAbsolute(p) ? p : path.join(cwd, p)
        );
      }
    }
  }

  // 3. Fallback to root tsconfig.json
  return [path.join(cwd, "tsconfig.json")];
}

export function buildGraph(args: Record<string, unknown>): ToolResult {
  // MCP サーバーは Claude Code から起動されるため process.cwd() がプロジェクトルートとは限らない。
  // TS_REVIEW_GRAPH_DB が設定されている場合はそこからプロジェクトルートを逆算する。
  const envDb = process.env["TS_REVIEW_GRAPH_DB"];
  const dbPath = envDb ?? path.join(process.cwd(), ".ts-review-graph/graph.db");
  const cwd = envDb
    ? path.resolve(path.dirname(envDb), "..")
    : process.cwd();

  const rawTsconfigs = args["tsconfigs"];
  const argTsconfigs =
    Array.isArray(rawTsconfigs) && rawTsconfigs.every((x) => typeof x === "string")
      ? (rawTsconfigs as string[])
      : undefined;
  const tsconfigPaths = loadTsconfigPaths(cwd, argTsconfigs);

  const missing = tsconfigPaths.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    return {
      content: [
        {
          type: "text",
          text: `tsconfig.json not found: ${missing.join(", ")}`,
        },
      ],
      isError: true,
    };
  }

  let db: ReturnType<typeof openDb>;
  try {
    db = openDb(dbPath);
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `データベースを開けませんでした — ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }

  try {
    const startMs = Date.now();
    buildFullGraph(db, tsconfigPaths);
    const elapsed = Date.now() - startMs;

    // グラフ構築成功後の統計取得 — 失敗してもグラフ構築成功は確定なので別 catch で区別する
    try {
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
    } catch {
      return {
        content: [{ type: "text", text: `グラフ構築完了 (${elapsed}ms) — 統計情報の取得に失敗しました` }],
      };
    }
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `グラフ構築に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  } finally {
    db.close();
  }
}
