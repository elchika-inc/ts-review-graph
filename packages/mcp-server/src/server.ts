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
    { name: "ts-review-graph", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  const db = existsSync(DB_PATH) ? openDb(DB_PATH) : null;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return registerTools(
      db,
      request.params.name,
      request.params.arguments ?? {}
    );
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
