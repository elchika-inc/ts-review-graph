import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION } from "../src/meta.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const hookPath = path.join(repoRoot, "packages/plugin/hooks/scripts/pre-read.sh");
const dbSchemaPath = path.join(repoRoot, "packages/core/src/db.ts");

// フックは bash + sqlite3 で DB を直接照会するため、core の TypeScript 実装とは
// 別実装になっている。過去に存在しない edge kind 'CALLS' が残り続けた実績があるため、
// 乖離を CI で検知する。
describe("pre-read.sh と core の乖離検知", () => {
  const hook = readFileSync(hookPath, "utf-8");

  it("フックが参照する edge kind がスキーマの定義と矛盾しない", () => {
    const VALID_KINDS = ["IMPORTS_FROM", "TYPED_BY", "IMPLEMENTS", "EXTENDS", "HAS_TEST"];
    // フック内の 'XXX' 形式のリテラルのうち、大文字とアンダースコアのみのものを抽出
    const literals = [...hook.matchAll(/'([A-Z][A-Z_]+)'/g)].map((m) => m[1]);
    const kindLiterals = literals.filter((l) => l !== "SELECT" && l !== "DISTINCT");
    for (const kind of kindLiterals) {
      expect(VALID_KINDS).toContain(kind);
    }
  });

  it("VALID_KINDS が db.ts のスキーマコメントと一致する", () => {
    const dbSrc = readFileSync(dbSchemaPath, "utf-8");
    // db.ts に kind の一覧が記述されていることを確認する（陳腐化検知の起点）
    for (const kind of ["IMPORTS_FROM", "TYPED_BY", "IMPLEMENTS", "EXTENDS"]) {
      expect(dbSrc).toContain(kind);
    }
  });

  it("フックが schema_version を検査している", () => {
    expect(hook).toContain("schema_version");
    expect(hook.match(/^SCHEMA_VERSION="([^"]+)"$/m)?.[1]).toBe(SCHEMA_VERSION);

    const input = JSON.stringify({ tool_input: { file_path: "src/a.ts" } });
    const missingDb = path.join(os.tmpdir(), `ts-rg-missing-${randomUUID()}`, "graph.db");
    expect(
      execFileSync("bash", [hookPath], {
        input,
        encoding: "utf8",
        env: { ...process.env, TS_REVIEW_GRAPH_DB: missingDb },
      })
    ).toBe("");

    const legacyDb = path.join(os.tmpdir(), `ts-rg-hook-legacy-${randomUUID()}.db`);
    try {
      execFileSync("sqlite3", [
        legacyDb,
        "CREATE TABLE nodes (id TEXT, kind TEXT, name TEXT, file TEXT, line INTEGER, type_refs TEXT); CREATE TABLE edges (source_id TEXT, target_id TEXT, kind TEXT);",
      ]);
      const output = execFileSync("bash", [hookPath], {
        input,
        encoding: "utf8",
        env: { ...process.env, TS_REVIEW_GRAPH_DB: legacyDb },
      });
      expect(output).toContain("グラフが旧形式です");
      expect(output).not.toContain("Blast radius for:");
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = legacyDb + suffix;
        if (existsSync(file)) rmSync(file);
      }
    }
  });
});
