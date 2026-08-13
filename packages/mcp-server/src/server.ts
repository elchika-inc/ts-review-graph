#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { openDb, formatNpxAbiMismatchGuidance } from "@elchika-inc/ts-review-graph-core";
import { registerTools, TOOL_DEFINITIONS, type DbOpenFailure } from "./tools/index.js";
import { openGraphDb } from "./open-graph-db.js";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const _pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
const _version = (JSON.parse(readFileSync(_pkgPath, "utf-8")) as { version: string }).version;

const DB_PATH =
  process.env["TS_REVIEW_GRAPH_DB"] ??
  path.join(process.cwd(), ".ts-review-graph/graph.db");

async function main(): Promise<void> {
  const server = new Server(
    { name: "ts-review-graph", version: _version },
    { capabilities: { tools: {} } }
  );

  // db はミュータブル — build_graph 後にグラフ DB が作成されたら再オープンする
  let db: ReturnType<typeof openDb> | null = null;
  // オープン失敗の理由も可変 — 再オープンの成否に合わせて更新する。
  // null は「DB ファイルが無い（＝本当に未構築）」を意味し、失敗と区別される。
  let dbFailure: DbOpenFailure | null = null;
  if (existsSync(DB_PATH)) {
    const opened = openGraphDb(DB_PATH, openDb);
    db = opened.db;
    dbFailure = opened.failure;
    if (dbFailure) {
      console.error(`[ts-review-graph] DB オープン失敗 — degraded mode で起動します: ${dbFailure.message}`);
      for (const line of formatNpxAbiMismatchGuidance(dbFailure.message)) {
        console.error(`[ts-review-graph]   ${line}`);
      }
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = registerTools(db, request.params.name, request.params.arguments ?? {}, dbFailure);

      // build_graph が成功した後、DB ファイルが存在すれば接続を初期化/再オープンする
      if (request.params.name === "build_graph" && result.isError !== true && existsSync(DB_PATH)) {
        const reopened = openGraphDb(DB_PATH, openDb);
        if (reopened.db) {
          const oldDb = db;
          db = reopened.db;
          dbFailure = null;
          try { oldDb?.close(); } catch (closeErr) {
            console.error(`[ts-review-graph] 旧 DB クローズに失敗: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`);
          }
        } else {
          dbFailure = reopened.failure;
          console.error(`[ts-review-graph] ビルド後の DB 再接続に失敗: ${reopened.failure?.message}`);
          for (const line of formatNpxAbiMismatchGuidance(reopened.failure?.message ?? "")) {
            console.error(`[ts-review-graph]   ${line}`);
          }
        }
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    try {
      db?.close();
      db = null;
      await server.close();
    } catch (err) {
      console.error("[ts-review-graph] shutdown error:", err);
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

main().catch(console.error);
