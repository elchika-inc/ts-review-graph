import { afterEach, describe, expect, it } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const syncScript = path.join(repoRoot, "scripts/sync-version.mjs");
const temporaryRoots: string[] = [];
const targetFiles = [
  "cli/package.json",
  "packages/core/package.json",
  "packages/mcp-server/package.json",
  ".claude-plugin/marketplace.json",
  "packages/plugin/.claude-plugin/plugin.json",
  "packages/plugin/.mcp.json",
  "packages/plugin/hooks/scripts/post-write.sh",
  "packages/plugin/skills/ts-review-graph/SKILL.md",
];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "ts-review-graph-version-"));
  temporaryRoots.push(root);
  for (const relativePath of targetFiles) {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(repoRoot, relativePath), destination);
  }
  writeFileSync(path.join(root, ".mcp.json"), '{"untouched":"@1.2.3"}\n');
  return root;
}

function writeCliVersion(root: string, version: string) {
  const packagePath = path.join(root, "cli/package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf-8")) as Record<
    string,
    unknown
  >;
  packageJson.version = version;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function runSync(root: string) {
  return spawnSync(process.execPath, [syncScript], {
    cwd: root,
    encoding: "utf-8",
  });
}

function readJson<T>(root: string, relativePath: string): T {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf-8")) as T;
}

describe("sync-version", () => {
  it("cli package の version を全consumerへ反映し、2回目はファイルを変更しない", () => {
    const root = createFixture();
    writeCliVersion(root, "9.9.9");

    const first = runSync(root);

    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("9.9.9");
    expect(
      readJson<{ version: string }>(root, "packages/core/package.json").version
    ).toBe("9.9.9");
    expect(
      readJson<{ version: string }>(root, "packages/mcp-server/package.json").version
    ).toBe("9.9.9");
    expect(
      readJson<{ plugins: Array<{ version: string }> }>(
        root,
        ".claude-plugin/marketplace.json"
      ).plugins[0]?.version
    ).toBe("9.9.9");
    expect(
      readJson<{ version: string }>(root, "packages/plugin/.claude-plugin/plugin.json")
        .version
    ).toBe("9.9.9");
    expect(
      readJson<{ mcpServers: { "ts-review-graph": { args: string[] } } }>(
        root,
        "packages/plugin/.mcp.json"
      ).mcpServers["ts-review-graph"].args
    ).toContain("@elchika-inc/ts-review-graph-mcp-server@9.9.9");
    expect(
      readFileSync(path.join(root, "packages/plugin/hooks/scripts/post-write.sh"), "utf-8")
    ).toContain("@elchika-inc/ts-review-graph@9.9.9 update");
    const skill = readFileSync(
      path.join(root, "packages/plugin/skills/ts-review-graph/SKILL.md"),
      "utf-8"
    );
    expect(skill).toMatch(/^version: 9\.9\.9$/m);
    expect(skill).toContain("@elchika-inc/ts-review-graph@9.9.9 build");
    expect(readFileSync(path.join(root, ".mcp.json"), "utf-8")).toBe(
      '{"untouched":"@1.2.3"}\n'
    );

    const afterFirst = targetFiles.map((relativePath) =>
      readFileSync(path.join(root, relativePath), "utf-8")
    );
    const second = runSync(root);
    const afterSecond = targetFiles.map((relativePath) =>
      readFileSync(path.join(root, relativePath), "utf-8")
    );
    expect(second.status, second.stderr).toBe(0);
    expect(afterSecond).toEqual(afterFirst);
  });

  it("同期対象が欠けている場合は対象名を出して非ゼロ終了する", () => {
    const root = createFixture();
    const corePackagePath = path.join(root, "packages/core/package.json");
    const corePackageBefore = readFileSync(corePackagePath, "utf-8");
    writeCliVersion(root, "9.9.9");
    rmSync(path.join(root, "packages/plugin/.mcp.json"));

    const result = runSync(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("packages/plugin/.mcp.json");
    expect(readFileSync(corePackagePath, "utf-8")).toBe(corePackageBefore);
  });

  it("同期対象が想定形式でない場合は対象名を出して非ゼロ終了する", () => {
    const root = createFixture();
    const corePackagePath = path.join(root, "packages/core/package.json");
    const corePackageBefore = readFileSync(corePackagePath, "utf-8");
    writeCliVersion(root, "9.9.9");
    writeFileSync(
      path.join(root, "packages/plugin/hooks/scripts/post-write.sh"),
      "#!/usr/bin/env bash\nexit 0\n"
    );

    const result = runSync(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("packages/plugin/hooks/scripts/post-write.sh");
    expect(readFileSync(corePackagePath, "utf-8")).toBe(corePackageBefore);
  });
});
