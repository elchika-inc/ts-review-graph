import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_DEFINITIONS } from "../../packages/mcp-server/src/tools/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginRoot = path.join(repoRoot, "packages/plugin");
const marketplacePath = path.join(repoRoot, ".claude-plugin/marketplace.json");

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

function readFilesRecursively(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    return entry.isDirectory()
      ? readFilesRecursively(entryPath)
      : [readFileSync(entryPath, "utf-8")];
  });
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

  it("plugin の配布物5箇所と公開3 package の version が一致する", () => {
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
    const cliPackageReference = `npx -y @elchika-inc/ts-review-graph@${plugin.version}`;
    const postWrite = readFileSync(
      path.join(pluginRoot, "hooks/scripts/post-write.sh"),
      "utf-8"
    );
    const skill = readFileSync(
      path.join(pluginRoot, "skills/ts-review-graph/SKILL.md"),
      "utf-8"
    );

    expect(marketplace.plugins[0]!.version).toBe(plugin.version);
    expect(packageVersions).toEqual([plugin.version, plugin.version, plugin.version]);
    expect(mcp.mcpServers["ts-review-graph"]).toEqual({
      command: "npx",
      args: ["-y", `@elchika-inc/ts-review-graph-mcp-server@${plugin.version}`],
    });
    expect(postWrite).toContain(`${cliPackageReference} update`);
    expect(skill).toContain(`${cliPackageReference} build`);
  });

  it("plugin 配下に unscoped CLI の npx 実行がない", () => {
    const pluginFiles = readFilesRecursively(pluginRoot);

    expect(pluginFiles.join("\n")).not.toMatch(/\bnpx\s+(?:-y\s+)?ts-review-graph\b/);
  });

  it("hook manifest が Claude Code plugin の入れ子構造に従う", () => {
    const hookManifest = readJson<{
      hooks?: Record<string, Array<{ matcher: string; hooks: Array<{ timeout: number }> }>>;
    }>(path.join(pluginRoot, "hooks/hooks.json"));

    expect(hookManifest.hooks?.PreToolUse?.[0]?.matcher).toBe("Read");
    expect(hookManifest.hooks?.PreToolUse?.[0]?.hooks[0]?.timeout).toBe(5);
    expect(hookManifest.hooks?.PostToolUse?.[0]?.matcher).toBe("Write|Edit");
    expect(hookManifest.hooks?.PostToolUse?.[0]?.hooks[0]?.timeout).toBe(10);
  });

  it("build command の tsconfig 引数が MCP schema と一致する", () => {
    const buildGraph = TOOL_DEFINITIONS.find((tool) => tool.name === "build_graph") as {
      inputSchema: { properties: Record<string, { type: string }> };
    };
    const buildCommand = readFileSync(
      path.join(pluginRoot, "commands/build.md"),
      "utf-8"
    );

    expect(buildGraph.inputSchema.properties.tsconfigs?.type).toBe("array");
    expect(buildCommand).toContain("`tsconfigs: [<path>]`");
    expect(buildCommand).not.toContain("`tsconfig`");
  });
});
