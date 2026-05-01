import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { updateFile } from "../src/updater.js";
import { rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DB = `/tmp/ts-review-graph-updater-test-${Date.now()}.db`;

let db: ReturnType<typeof openDb>;
let tmpDir: string;

beforeEach(() => {
  db = openDb(TEST_DB);
  tmpDir = path.join(os.tmpdir(), `ts-rg-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = TEST_DB + ext;
    if (existsSync(p)) rmSync(p);
  }
});

describe("updateFile", () => {
  it("初回はノードを挿入する", () => {
    const filePath = path.join(tmpDir, "a.ts");
    writeFileSync(filePath, "export function foo() {}");

    updateFile(db, filePath);

    const nodes = db.prepare("SELECT * FROM nodes WHERE file = ?").all(filePath);
    expect(nodes.length).toBeGreaterThan(0);
  });

  it("内容が変わらなければ 'skipped' を返す", () => {
    const filePath = path.join(tmpDir, "b.ts");
    writeFileSync(filePath, "export function bar() {}");

    updateFile(db, filePath);
    const result = updateFile(db, filePath); // 再実行

    expect(result).toBe("skipped");
  });

  it("内容が変わったら 'updated' を返しノードを更新する", () => {
    const filePath = path.join(tmpDir, "c.ts");
    writeFileSync(filePath, "export function baz() {}");
    updateFile(db, filePath);

    // baz を削除した新しい内容
    writeFileSync(filePath, "// empty");
    const result = updateFile(db, filePath);

    expect(result).toBe("updated");
    const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(`${filePath}::baz`);
    expect(node).toBeUndefined(); // baz ノードが消えている
  });
});
