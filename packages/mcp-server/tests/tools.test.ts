import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "@ts-review-graph/core";
import { registerTools } from "../src/tools/index.js";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

// プロジェクトルートを擬似的に作成し、DB パスを nested に設定する。
// resolveFilePath は TS_REVIEW_GRAPH_DB から projectRoot を逆算するため、
// DB が <projectRoot>/.ts-review-graph/graph.db に配置される形にする。
const TEST_PROJECT_ROOT = `/tmp/ts-rg-tools-test-${Date.now()}`;
const TEST_DB = path.join(TEST_PROJECT_ROOT, ".ts-review-graph", "graph.db");

// 本番の analyzeProject と同様に絶対パスでファイルを登録する
const IMPL_FILE = path.join(TEST_PROJECT_ROOT, "impl.ts");
const DEP_FILE = path.join(TEST_PROJECT_ROOT, "dep.ts");
const TEST_FILE = path.join(TEST_PROJECT_ROOT, "impl.test.ts");

let db: ReturnType<typeof openDb>;

beforeEach(() => {
  // TS_REVIEW_GRAPH_DB を設定して resolveFilePath がプロジェクトルートを正しく解決できるようにする
  process.env["TS_REVIEW_GRAPH_DB"] = TEST_DB;

  db = openDb(TEST_DB);

  // impl.ts ノード (絶対パス)
  db.prepare(
    "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
  ).run("impl::__file__", "file", "impl.ts", IMPL_FILE, 1, "[]");

  // dep.ts ノード（impl.ts が import している、絶対パス）
  db.prepare(
    "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
  ).run("dep::__file__", "file", "dep.ts", DEP_FILE, 1, "[]");

  // impl.test.ts ノード (絶対パス)
  db.prepare(
    "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
  ).run("test::__file__", "test", "impl.test.ts", TEST_FILE, 1, "[]");

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
  delete process.env["TS_REVIEW_GRAPH_DB"];
  db.close();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = TEST_DB + ext;
    if (existsSync(p)) rmSync(p);
  }
});

describe("registerTools", () => {
  it("get_minimal_context がファイルリストを含むテキストを返す", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [IMPL_FILE],
      mode: "review",
    });
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("impl.ts");
  });

  it("get_test_coverage がテストファイルを返す", () => {
    const result = registerTools(db, "get_test_coverage", { file: IMPL_FILE });
    expect(result.content[0].text).toContain("impl.test.ts");
  });

  it("graph_status がノード数を返す", () => {
    const result = registerTools(db, "graph_status", {});
    expect(result.content[0].text).toContain("nodes");
  });

  it("graph_status は db=null のときもエラーなしで状態を返す", () => {
    const result = registerTools(null, "graph_status", {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("未構築");
  });

  it("db=null のとき未構築メッセージを返す（build_graph 以外）", () => {
    const result = registerTools(null, "get_impact", { changed_file: "x.ts" });
    expect(result.content[0].text).toContain("未構築");
  });

  it("implement モードで REVERSE と FORWARD の両セクションを含む", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [IMPL_FILE],
      mode: "implement",
    });
    const text = result.content[0].text;
    expect(text).toContain("影響を受けるファイル");
    expect(text).toContain("一緒に変えるべきファイル");
    expect(text).toContain("dep.ts");
  });

  it("review モードでは FORWARD セクションを含まない", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [IMPL_FILE],
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

  it("get_impact: changed_file が未指定のとき isError を返す", () => {
    const result = registerTools(db, "get_impact", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("changed_file");
  });

  it("get_type_usages: type_name が未指定のとき isError を返す", () => {
    const result = registerTools(db, "get_type_usages", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("type_name");
  });

  it("query_graph: from が未指定のとき isError を返す", () => {
    const result = registerTools(db, "query_graph", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("from");
  });

  it("get_test_coverage: file が未指定のとき isError を返す", () => {
    const result = registerTools(db, "get_test_coverage", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("file");
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
        changed_files: [IMPL_FILE],
        mode: "invalid",
      })
    ).toThrow("mode must be one of");
  });

  it("プロジェクト外の絶対パスはエラーをスロー", () => {
    expect(() =>
      registerTools(db, "get_minimal_context", {
        changed_files: ["/etc/passwd"],
        mode: "review",
      })
    ).toThrow("Path traversal detected");
  });

  it("パストラバーサル（../../）はエラーをスロー", () => {
    expect(() =>
      registerTools(db, "get_minimal_context", {
        changed_files: ["../../etc/passwd"],
        mode: "review",
      })
    ).toThrow("Path traversal detected");
  });
});
