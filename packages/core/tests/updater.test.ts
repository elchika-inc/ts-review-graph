import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { updateFile, buildFullGraph } from "../src/updater.js";
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

describe("buildFullGraph", () => {
  it("複数 tsconfig のノードを単一 DB にマージする", () => {
    // フィクスチャ1: temp ディレクトリに a.ts
    const dir1 = path.join(os.tmpdir(), `ts-rg-fixture1-${Date.now()}`);
    mkdirSync(dir1, { recursive: true });
    writeFileSync(
      path.join(dir1, "a.ts"),
      "export function greetA() { return 'a'; }"
    );
    writeFileSync(
      path.join(dir1, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "ES2022" }, include: ["a.ts"] })
    );

    // フィクスチャ2: 別 temp ディレクトリに b.ts
    const dir2 = path.join(os.tmpdir(), `ts-rg-fixture2-${Date.now()}`);
    mkdirSync(dir2, { recursive: true });
    writeFileSync(
      path.join(dir2, "b.ts"),
      "export function greetB() { return 'b'; }"
    );
    writeFileSync(
      path.join(dir2, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "ES2022" }, include: ["b.ts"] })
    );

    buildFullGraph(db, [
      path.join(dir1, "tsconfig.json"),
      path.join(dir2, "tsconfig.json"),
    ]);

    // 両方のファイルノードが DB に存在する
    const aNode = db
      .prepare("SELECT * FROM nodes WHERE name = 'greetA'")
      .get();
    expect(aNode).toBeTruthy();

    const bNode = db
      .prepare("SELECT * FROM nodes WHERE name = 'greetB'")
      .get();
    expect(bNode).toBeTruthy();
  });

  it("空配列を渡した場合はノードを挿入しない", () => {
    buildFullGraph(db, []);
    const count = (
      db.prepare("SELECT COUNT(*) as c FROM nodes").get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });
});
