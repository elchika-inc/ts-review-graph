import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { computeBlastRadius } from "../src/blast.js";
import { rmSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/ts-review-graph-blast-test.db";

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

beforeEach(() => {
  db = openDb(TEST_DB);
});

afterEach(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = TEST_DB + ext;
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
});
