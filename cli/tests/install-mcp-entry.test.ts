import { describe, it, expect } from "vitest";
import { buildMcpServerEntry } from "../src/mcp-entry.js";

describe("buildMcpServerEntry", () => {
  it("既定の DB パスなら env を含めない", () => {
    const entry = buildMcpServerEntry("/repo", "/repo/.ts-review-graph/graph.db");
    expect(entry).toEqual({
      command: "npx",
      args: ["-y", "@elchika-inc/ts-review-graph-mcp-server"],
    });
    expect("env" in entry).toBe(false);
  });

  it("既定以外の DB パスなら相対パスの env を書く", () => {
    const entry = buildMcpServerEntry("/repo", "/repo/custom/graph.db");
    expect(entry.env).toEqual({ TS_REVIEW_GRAPH_DB: "custom/graph.db" });
  });

  it("既存エントリを置き換えるので古い env は残らない", () => {
    const mcpServers: Record<string, unknown> = {
      "ts-review-graph": {
        command: "npx",
        args: ["-y", "@elchika-inc/ts-review-graph-mcp-server"],
        env: { TS_REVIEW_GRAPH_DB: "/old/absolute/path/graph.db" },
      },
    };
    mcpServers["ts-review-graph"] = buildMcpServerEntry("/repo", "/repo/.ts-review-graph/graph.db");
    expect(mcpServers["ts-review-graph"]).not.toHaveProperty("env");
  });
});
