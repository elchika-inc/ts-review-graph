import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(cliRoot, "dist/index.js");
const loaderPath = path.join(cliRoot, "tests/fixtures/abi-core-loader.mjs");
const roots: string[] = [];

const commands = [
  ["install", "install", "--tsconfig", "tsconfig.json", "--db", "graph.db"],
  ["build", "build", "--tsconfig", "tsconfig.json", "--db", "graph.db"],
  ["update", "update", "src/main.ts", "--db", "graph.db"],
  ["status", "status", "--db", "graph.db"],
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createProject(): string {
  const root = path.join(os.tmpdir(), `ts-rg-abi-${randomUUID()}`);
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
  writeFileSync(path.join(root, "graph.db"), "");
  return root;
}

function runCommand(root: string, args: readonly string[], errorMessage: string) {
  return spawnSync(
    process.execPath,
    ["--experimental-loader", loaderPath, cliPath, ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TS_REVIEW_GRAPH_TEST_DB_ERROR: errorMessage },
    }
  );
}

describe("DB open の ABI 診断", () => {
  for (const [name, ...args] of commands) {
    it(`${name} が ABI 不一致の cache 削除案内を表示する`, () => {
      const result = runCommand(
        createProject(),
        args,
        "The module '/Users/test/.npm/_npx/08af52269914770e/node_modules/addon.node' uses NODE_MODULE_VERSION 137"
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ネイティブモジュールの Node ABI が一致していません。");
      expect(result.stderr).toContain(
        "rm -rf -- '/Users/test/.npm/_npx/08af52269914770e'"
      );
      expect(result.stderr).toContain("同じコマンドを再実行してください");
      expect(result.stderr).not.toContain("install を再試行");
    });

    it(`${name} が非 ABI error では cache 削除案内を表示しない`, () => {
      const result = runCommand(createProject(), args, "database is locked");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("database is locked");
      expect(result.stderr).not.toContain("ネイティブモジュールの Node ABI");
      expect(result.stderr).not.toContain("rm -rf");
    });
  }
});
