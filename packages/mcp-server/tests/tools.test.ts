import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "@ts-review-graph/core";
import { registerTools } from "../src/tools/index.js";
import { rmSync, existsSync } from "node:fs";

const TEST_DB = `/tmp/ts-rg-tools-test-${Date.now()}.db`;

let db: ReturnType<typeof openDb>;

beforeEach(() => {
  db = openDb(TEST_DB);

  // impl.ts ノード
  db.prepare(
    "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
  ).run("impl::__file__", "file", "impl.ts", "impl.ts", 1, "[]");

  // dep.ts ノード（impl.ts が import している）
  db.prepare(
    "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
  ).run("dep::__file__", "file", "dep.ts", "dep.ts", 1, "[]");

  // impl.test.ts ノード
  db.prepare(
    "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
  ).run("test::__file__", "test", "impl.test.ts", "impl.test.ts", 1, "[]");

  // HAS_TEST: impl → test
  db.prepare(
    "INSERT OR REPLACE INTO edges (source_id, target_id, kind) VALUES (?,?,?)"
  ).run("impl::__file__", "test::__file__", "HAS_TEST");

  // IMPORTS_FROM: impl → dep (impl.ts が dep.ts を import)
  db.prepare(
    "INSERT OR REPLACE INTO edges (source_id, target_id, kind) VALUES (?,?,?)"
  ).run("impl::__file__", "dep::__file__", "IMPORTS_FROM");
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

  it("implement モードで REVERSE と FORWARD の両セクションを含む", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: ["impl.ts"],
      mode: "implement",
    });
    const text = result.content[0].text;
    expect(text).toContain("影響を受けるファイル");
    expect(text).toContain("一緒に変えるべきファイル");
    expect(text).toContain("dep.ts");
  });

  it("review モードでは FORWARD セクションを含まない", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: ["impl.ts"],
      mode: "review",
    });
    const text = result.content[0].text;
    expect(text).not.toContain("一緒に変えるべきファイル");
  });

  it("db=null のとき isError: true を返す", () => {
    const result = registerTools(null, "get_impact", { changed_file: "x.ts" });
    expect(result.isError).toBe(true);
  });

  it("不明なツール名は isError: true を返す", () => {
    const result = registerTools(db, "nonexistent_tool", {});
    expect(result.isError).toBe(true);
  });
});

describe("get_minimal_context 引数バリデーション", () => {
  it("changed_files が配列でない場合はエラーをスロー", () => {
    expect(() =>
      registerTools(db, "get_minimal_context", {
        changed_files: "single-string",
        mode: "review",
      })
    ).toThrow("changed_files must be a non-empty array of strings");
  });

  it("changed_files が空配列の場合はエラーをスロー", () => {
    expect(() =>
      registerTools(db, "get_minimal_context", {
        changed_files: [],
        mode: "review",
      })
    ).toThrow("changed_files must be a non-empty array of strings");
  });

  it("mode が不正な値の場合はエラーをスロー", () => {
    expect(() =>
      registerTools(db, "get_minimal_context", {
        changed_files: ["impl.ts"],
        mode: "invalid",
      })
    ).toThrow("mode must be one of");
  });
});
