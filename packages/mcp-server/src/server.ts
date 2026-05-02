#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "@ts-review-graph/core";
import { registerTools, TOOL_DEFINITIONS } from "./tools/index.js";
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
  if (existsSync(DB_PATH)) {
    try {
      db = openDb(DB_PATH);
    } catch (err) {
      console.error(`[ts-review-graph] DB オープン失敗 — degraded mode で起動します: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = registerTools(db, request.params.name, request.params.arguments ?? {});

      // build_graph が成功した後、DB ファイルが存在すれば接続を初期化/再オープンする
      if (request.params.name === "build_graph" && !result.isError && existsSync(DB_PATH)) {
        try {
          const newDb = openDb(DB_PATH);
          db?.close();
          db = newDb;
        } catch (err) {
          console.error(`[ts-review-graph] ビルド後の DB 再接続に失敗: ${err instanceof Error ? err.message : String(err)}`);
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
    db?.close();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}

main().catch(console.error);
