import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { computeBlastRadius, computeForwardDeps } from "../src/blast.js";
import { rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

function insertNode(db: ReturnType<typeof openDb>, id: string, file: string) {
  db.prepare(
    "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
  ).run(id, "function", id, file, 1, "[]");
}

function insertEdge(
  db: ReturnType<typeof openDb>,
  source: string,
  target: string,
  kind: string
) {
  db.prepare(
    "INSERT OR REPLACE INTO edges (source_id, target_id, kind) VALUES (?,?,?)"
  ).run(source, target, kind);
}

let db: ReturnType<typeof openDb>;
let testDb: string;

beforeEach(() => {
  testDb = `/tmp/ts-review-graph-blast-test-${randomUUID()}.db`;
  db = openDb(testDb);
});

afterEach(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = testDb + ext;
    if (existsSync(p)) rmSync(p);
  }
});

describe("computeBlastRadius", () => {
  it("直接依存ファイルを返す（depth=1）", () => {
    // b が a を IMPORTS_FROM → a を変更すると b が影響を受ける
    insertNode(db, "a", "a.ts");
    insertNode(db, "b", "b.ts");
    insertEdge(db, "b", "a", "IMPORTS_FROM"); // source=b, target=a

    const result = computeBlastRadius(db, "a.ts", 1);
    const files = result.map((r) => r.file);
    expect(files).toContain("b.ts");
    expect(files).toContain("a.ts"); // 変更ファイル自身も含む
  });

  it("HAS_TEST は前方探索で取得できる", () => {
    insertNode(db, "impl", "impl.ts");
    insertNode(db, "test", "impl.test.ts");
    insertEdge(db, "impl", "test", "HAS_TEST"); // source=実装, target=テスト

    const result = computeBlastRadius(db, "impl.ts", 2);
    const files = result.map((r) => r.file);
    expect(files).toContain("impl.test.ts");
  });

  it("depth 上限を超えたノードは含まれない", () => {
    // a → b → c → d (4段チェーン、b が a を IMPORTS_FROM、c が b を IMPORTS_FROM...)
    insertNode(db, "a", "a.ts");
    insertNode(db, "b", "b.ts");
    insertNode(db, "c", "c.ts");
    insertNode(db, "d", "d.ts");
    insertEdge(db, "b", "a", "IMPORTS_FROM");
    insertEdge(db, "c", "b", "IMPORTS_FROM");
    insertEdge(db, "d", "c", "IMPORTS_FROM");

    const result = computeBlastRadius(db, "a.ts", 2);
    const files = result.map((r) => r.file);
    expect(files).toContain("b.ts");
    expect(files).toContain("c.ts");
    expect(files).not.toContain("d.ts"); // depth=2 で止まる
  });

  it("循環依存（A→B→A）でも無限ループしない", () => {
    // A と B が相互 IMPORTS_FROM する循環グラフ
    insertNode(db, "a", "a.ts");
    insertNode(db, "b", "b.ts");
    insertEdge(db, "a", "b", "IMPORTS_FROM");
    insertEdge(db, "b", "a", "IMPORTS_FROM");

    // UNION（重複排除）により無限展開しないことを確認
    expect(() => computeBlastRadius(db, "a.ts", 5)).not.toThrow();
    const result = computeBlastRadius(db, "a.ts", 5);
    const files = result.map((r) => r.file);
    expect(files).toContain("a.ts");
    expect(files).toContain("b.ts");
  });

  it("3ノード循環依存（A→B→C→A）でも有限結果を返す", () => {
    insertNode(db, "a", "a.ts");
    insertNode(db, "b", "b.ts");
    insertNode(db, "c", "c.ts");
    insertEdge(db, "a", "b", "IMPORTS_FROM");
    insertEdge(db, "b", "c", "IMPORTS_FROM");
    insertEdge(db, "c", "a", "IMPORTS_FROM");

    expect(() => computeBlastRadius(db, "a.ts", 10)).not.toThrow();
    const result = computeBlastRadius(db, "a.ts", 10);
    expect(result.length).toBeLessThanOrEqual(3);
  });
});

describe("computeForwardDeps", () => {
  it("直接 import しているファイルを返す", () => {
    // monitors.ts が schema.ts を IMPORTS_FROM するケース
    insertNode(db, "monitors::__file__", "monitors.ts");
    insertNode(db, "schema::__file__", "schema.ts");
    insertEdge(db, "monitors::__file__", "schema::__file__", "IMPORTS_FROM");

    const result = computeForwardDeps(db, "monitors.ts");
    const files = result.map((r) => r.file);
    expect(files).toContain("schema.ts");
    expect(files).not.toContain("monitors.ts"); // 自身は含まない
  });

  it("depth=1 固定 — 間接依存は含まない", () => {
    insertNode(db, "a::__file__", "a.ts");
    insertNode(db, "b::__file__", "b.ts");
    insertNode(db, "c::__file__", "c.ts");
    insertEdge(db, "a::__file__", "b::__file__", "IMPORTS_FROM");
    insertEdge(db, "b::__file__", "c::__file__", "IMPORTS_FROM");

    const result = computeForwardDeps(db, "a.ts");
    const files = result.map((r) => r.file);
    expect(files).toContain("b.ts");
    expect(files).not.toContain("c.ts");
  });

  it("import 先がない場合は空配列", () => {
    insertNode(db, "standalone::__file__", "standalone.ts");

    const result = computeForwardDeps(db, "standalone.ts");
    expect(result).toHaveLength(0);
  });
});
