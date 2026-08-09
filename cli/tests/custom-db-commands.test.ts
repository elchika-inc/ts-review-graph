import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDb } from "@elchika-inc/ts-review-graph-core";

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("custom DB を使う CLI コマンド", () => {
  it("build・status・update が cwd を projectRoot として使う", () => {
    expect(existsSync(cliPath)).toBe(true);
    const root = path.join(os.tmpdir(), `ts-rg-cli-custom-${randomUUID()}`);
    roots.push(root);
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src/a.ts"), "export const initial = 1;\n");
    writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext" },
        include: ["src"],
      })
    );

    const dbArg = "custom/deep/graph.db";
    const buildOutput = execFileSync(
      process.execPath,
      [cliPath, "build", "--tsconfig", "tsconfig.json", "--db", dbArg],
      { cwd: root, encoding: "utf8" }
    );
    expect(buildOutput).toContain("グラフ構築完了");

    const statusOutput = execFileSync(
      process.execPath,
      [cliPath, "status", "--db", dbArg],
      { cwd: root, encoding: "utf8" }
    );
    expect(statusOutput).toContain("health:     OK");

    writeFileSync(path.join(root, "src/a.ts"), "export const changed = 2;\n");
    const updateOutput = execFileSync(
      process.execPath,
      [cliPath, "update", "src/a.ts", "--db", dbArg],
      { cwd: root, encoding: "utf8" }
    );
    expect(updateOutput).toContain("更新完了: src/a.ts");

    const db = openDb(path.join(root, dbArg));
    try {
      const files = db.prepare("SELECT DISTINCT file FROM nodes").all() as { file: string }[];
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((row) => !path.isAbsolute(row.file))).toBe(true);
      expect(db.prepare("SELECT 1 FROM nodes WHERE id = ?").get("src/a.ts::changed")).toBeDefined();
    } finally {
      db.close();
    }
  });
});
