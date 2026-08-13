import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION } from "../src/meta.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const hookPath = path.join(repoRoot, "packages/plugin/hooks/scripts/pre-read.sh");
const postWriteHookPath = path.join(repoRoot, "packages/plugin/hooks/scripts/post-write.sh");
const dbSchemaPath = path.join(repoRoot, "packages/core/src/db.ts");

// フックは bash + sqlite3 で DB を直接照会するため、core の TypeScript 実装とは
// 別実装になっている。過去に存在しない edge kind 'CALLS' が残り続けた実績があるため、
// 乖離を CI で検知する。
describe("pre-read.sh と core の乖離検知", () => {
  const hook = readFileSync(hookPath, "utf-8");
  const dbSrc = readFileSync(dbSchemaPath, "utf-8");

  function schemaKinds(): string[] {
    const value = dbSrc.match(/-- edges\.kind の取りうる値: ([A-Z_| ]+)/)?.[1];
    expect(value).toBeDefined();
    return value!.split("|").map((kind) => kind.trim());
  }

  it("フックが参照する edge kind がスキーマの定義と矛盾しない", () => {
    const validKinds = schemaKinds();
    // フック内の 'XXX' 形式のリテラルのうち、大文字とアンダースコアのみのものを抽出
    const literals = [...hook.matchAll(/'([A-Z][A-Z_]+)'/g)].map((m) => m[1]);
    const kindLiterals = literals.filter((l) => l !== "SELECT" && l !== "DISTINCT");
    for (const kind of kindLiterals) {
      expect(validKinds).toContain(kind);
    }
  });

  it("VALID_KINDS が db.ts のスキーマコメントと一致する", () => {
    expect(schemaKinds()).toEqual([
      "IMPORTS_FROM",
      "TYPED_BY",
      "IMPLEMENTS",
      "EXTENDS",
      "HAS_TEST",
    ]);
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
      const payload = JSON.parse(output) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      expect(payload.hookSpecificOutput.hookEventName).toBe("PreToolUse");
      expect(payload.hookSpecificOutput.additionalContext).toContain("グラフが旧形式です");
      expect(payload.hookSpecificOutput.additionalContext).not.toContain("Blast radius for:");
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = legacyDb + suffix;
        if (existsSync(file)) rmSync(file);
      }
    }

    const currentDb = path.join(os.tmpdir(), `ts-rg-hook-current-${randomUUID()}.db`);
    try {
      const dependentSql = Array.from({ length: 21 }, (_, i) =>
        `INSERT INTO nodes VALUES ('dep${i}.ts::__file__', 'file', 'dep${i}.ts', 'dep${i}.ts', 1, NULL, '[]'); INSERT INTO edges VALUES ('dep${i}.ts::__file__', 'src/a.ts::__file__', 'IMPORTS_FROM');`
      ).join(" ") + " INSERT INTO edges VALUES ('dep0.ts::__file__', 'src/a.ts::__file__', 'TYPED_BY');";
      execFileSync("sqlite3", [
        currentDb,
        `CREATE TABLE nodes (id TEXT, kind TEXT, name TEXT, file TEXT, line INTEGER, signature TEXT, type_refs TEXT); CREATE TABLE edges (source_id TEXT, target_id TEXT, kind TEXT); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema_version', '${SCHEMA_VERSION}'); INSERT INTO nodes VALUES ('src/a.ts::__file__', 'file', 'a.ts', 'src/a.ts', 1, NULL, '[]'); ${dependentSql}`,
      ]);
      const output = execFileSync("bash", [hookPath], {
        input,
        encoding: "utf8",
        env: { ...process.env, TS_REVIEW_GRAPH_DB: currentDb },
      });
      const payload = JSON.parse(output) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      const context = payload.hookSpecificOutput.additionalContext;
      expect(context).toContain("TRUNCATED");
      expect(context).not.toContain("READ THESE FILES ONLY");
      expect(context).not.toContain("SKIP all other files");
      const resultLines = context.split("\n").filter((line) => line.startsWith("  "));
      expect(resultLines).toHaveLength(20);
      expect(new Set(resultLines.map((line) => line.trim().split(/\s{2}/)[0])).size).toBe(20);

      const fakeBin = path.join(os.tmpdir(), `ts-rg-hook-bin-${randomUUID()}`);
      mkdirSync(fakeBin);
      const fakeNpx = path.join(fakeBin, "npx");
      writeFileSync(fakeNpx, "#!/bin/sh\necho simulated update failure >&2\nexit 7\n");
      chmodSync(fakeNpx, 0o755);
      try {
        const updateResult = spawnSync("bash", [postWriteHookPath], {
          input,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
            TS_REVIEW_GRAPH_DB: currentDb,
          },
        });
        expect(updateResult.status).toBe(0);
        expect(updateResult.stderr).toContain("増分更新に失敗しました");
        expect(updateResult.stderr).toContain("simulated update failure");
      } finally {
        rmSync(fakeBin, { recursive: true, force: true });
      }
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = currentDb + suffix;
        if (existsSync(file)) rmSync(file);
      }
    }

    const corruptDb = path.join(os.tmpdir(), `ts-rg-hook-corrupt-${randomUUID()}.db`);
    try {
      writeFileSync(corruptDb, "not a sqlite database");
      const result = spawnSync("bash", [hookPath], {
        input,
        encoding: "utf8",
        env: { ...process.env, TS_REVIEW_GRAPH_DB: corruptDb },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("グラフ検査に失敗しました");
    } finally {
      rmSync(corruptDb, { force: true });
    }
  });
});
