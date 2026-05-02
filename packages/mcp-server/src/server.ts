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
import { existsSync } from "node:fs";

const DB_PATH =
  process.env["TS_REVIEW_GRAPH_DB"] ??
  path.join(process.cwd(), ".ts-review-graph/graph.db");

async function main(): Promise<void> {
  const server = new Server(
    { name: "ts-review-graph", version: "0.2.0" },
    { capabilities: { tools: {} } }
  );

  // db はミュータブル — build_graph 後にグラフ DB が作成されたら再オープンする
  let db = existsSync(DB_PATH) ? openDb(DB_PATH) : null;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = registerTools(db, request.params.name, request.params.arguments ?? {});

      // build_graph が成功した後、DB ファイルが存在すれば接続を初期化/再オープンする
      if (request.params.name === "build_graph" && !result.isError && existsSync(DB_PATH)) {
        db?.close();
        db = openDb(DB_PATH);
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
