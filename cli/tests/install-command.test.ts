import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(cliRoot, "dist/index.js");
const cliVersion = (
  JSON.parse(readFileSync(path.join(cliRoot, "package.json"), "utf-8")) as {
    version: string;
  }
).version;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("install command", () => {
  it("新規 project への2回実行で version 固定と ignore を冪等に生成する", () => {
    expect(existsSync(cliPath)).toBe(true);
    const root = path.join(os.tmpdir(), `ts-rg-cli-install-${randomUUID()}`);
    roots.push(root);
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src/main.ts"), "export const main = true;\n");
    writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext" },
        include: ["src"],
      })
    );

    execFileSync(process.execPath, [cliPath, "install", "--tsconfig", "tsconfig.json"], {
      cwd: root,
      encoding: "utf8",
    });
    const secondOutput = execFileSync(
      process.execPath,
      [cliPath, "install", "--tsconfig", "tsconfig.json"],
      { cwd: root, encoding: "utf8" }
    );

    const mcpJson = JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf-8")) as {
      mcpServers: { "ts-review-graph": { args: string[] } };
    };
    expect(mcpJson.mcpServers["ts-review-graph"].args).toEqual([
      "-y",
      `@elchika-inc/ts-review-graph-mcp-server@${cliVersion}`,
    ]);

    const gitignoreLines = readFileSync(path.join(root, ".gitignore"), "utf-8").split("\n");
    for (const line of [
      ".ts-review-graph/graph.db",
      ".ts-review-graph/graph.db-wal",
      ".ts-review-graph/graph.db-shm",
    ]) {
      expect(gitignoreLines.filter((candidate) => candidate === line)).toHaveLength(1);
    }
    expect(secondOutput).toContain("CLAUDE.md の ts-review-graph セクションは既に存在します（スキップ）");
  });
});
