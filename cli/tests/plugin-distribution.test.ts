import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginRoot = path.join(repoRoot, "packages/plugin");
const marketplacePath = path.join(repoRoot, ".claude-plugin/marketplace.json");

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

describe("Claude Code plugin の配布契約", () => {
  it("marketplace source が実在する plugin manifest を指す", () => {
    expect(existsSync(marketplacePath), "marketplace.json が存在する").toBe(true);
    if (!existsSync(marketplacePath)) return;

    const marketplace = readJson<{
      plugins: Array<{ source: string }>;
    }>(marketplacePath);
    const sourceRoot = path.resolve(repoRoot, marketplace.plugins[0]!.source);
    expect(sourceRoot).toBe(pluginRoot);
    expect(existsSync(path.join(sourceRoot, ".claude-plugin/plugin.json"))).toBe(true);
  });

  it("plugin・marketplace・MCP package と公開3 package の version が一致する", () => {
    expect(existsSync(marketplacePath), "marketplace.json が存在する").toBe(true);
    if (!existsSync(marketplacePath)) return;

    const plugin = readJson<{ version: string }>(
      path.join(pluginRoot, ".claude-plugin/plugin.json")
    );
    const marketplace = readJson<{
      plugins: Array<{ version: string }>;
    }>(marketplacePath);
    const mcp = readJson<{
      mcpServers: {
        "ts-review-graph": {
          command: string;
          args: string[];
          env?: Record<string, string>;
        };
      };
    }>(path.join(pluginRoot, ".mcp.json"));
    const packageVersions = [
      "packages/core/package.json",
      "packages/mcp-server/package.json",
      "cli/package.json",
    ].map((relativePath) =>
      readJson<{ version: string }>(path.join(repoRoot, relativePath)).version
    );

    expect(marketplace.plugins[0]!.version).toBe(plugin.version);
    expect(packageVersions).toEqual([plugin.version, plugin.version, plugin.version]);
    expect(mcp.mcpServers["ts-review-graph"]).toEqual({
      command: "npx",
      args: ["-y", `@elchika-inc/ts-review-graph-mcp-server@${plugin.version}`],
    });
  });
});
