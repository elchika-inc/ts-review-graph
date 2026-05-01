import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "@ts-review-graph/core";
import { registerTools } from "../src/tools/index.js";
import { rmSync, existsSync } from "node:fs";

const TEST_DB = `/tmp/ts-rg-tools-test-${Date.now()}.db`;

let db: ReturnType<typeof openDb>;

beforeEach(() => {
  db = openDb(TEST_DB);
  db.prepare(
    "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
  ).run("impl::__file__", "file", "impl.ts", "impl.ts", 1, "[]");
  db.prepare(
    "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
  ).run("test::__file__", "test", "impl.test.ts", "impl.test.ts", 1, "[]");
  db.prepare(
    "INSERT OR REPLACE INTO edges (source_id, target_id, kind) VALUES (?,?,?)"
  ).run("impl::__file__", "test::__file__", "HAS_TEST");
});

afterEach(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = TEST_DB + ext;
    if (existsSync(p)) rmSync(p);
  }
});

describe("registerTools", () => {
  it("get_minimal_context がファイルリストを含むテキストを返す", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: ["impl.ts"],
      mode: "review",
    });
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("impl.ts");
  });

  it("get_test_coverage がテストファイルを返す", () => {
    const result = registerTools(db, "get_test_coverage", { file: "impl.ts" });
    expect(result.content[0].text).toContain("impl.test.ts");
  });

  it("graph_status がノード数を返す", () => {
    const result = registerTools(db, "graph_status", {});
    expect(result.content[0].text).toContain("nodes");
  });

  it("db=null のとき未構築メッセージを返す（build_graph 以外）", () => {
    const result = registerTools(null, "get_impact", { changed_file: "x.ts" });
    expect(result.content[0].text).toContain("未構築");
  });
});
