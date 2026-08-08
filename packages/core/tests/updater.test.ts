import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { updateFile, buildFullGraph } from "../src/updater.js";
import { computeBlastRadius } from "../src/blast.js";
import { rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

let db: ReturnType<typeof openDb>;
let tmpDir: string;
let testDb: string;

beforeEach(() => {
  testDb = `/tmp/ts-review-graph-updater-test-${randomUUID()}.db`;
  db = openDb(testDb);
  tmpDir = path.join(os.tmpdir(), `ts-rg-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = testDb + ext;
    if (existsSync(p)) rmSync(p);
  }
  rmSync(tmpDir, { recursive: true, force: true });
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

  it("ファイルが存在しない場合はノードとハッシュを削除して 'deleted' を返す", () => {
    const filePath = path.join(tmpDir, "d.ts");
    writeFileSync(filePath, "export function gone() {}");
    updateFile(db, filePath);

    // ファイルを削除
    rmSync(filePath);
    const result = updateFile(db, filePath);

    expect(result).toBe("deleted");
    const nodes = db.prepare("SELECT * FROM nodes WHERE file = ?").all(filePath);
    expect(nodes.length).toBe(0);
    const hash = db.prepare("SELECT * FROM file_hashes WHERE file = ?").get(filePath);
    expect(hash).toBeUndefined();
  });

  it("エクスポート変数ノードが挿入される", () => {
    const filePath = path.join(tmpDir, "vars.ts");
    writeFileSync(filePath, "export const myConst = 42;");

    updateFile(db, filePath);

    const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(`${filePath}::myConst`);
    expect(node).toBeTruthy();
    expect((node as any).kind).toBe("variable");
  });

  it("import 先ノードが DB に存在する場合に IMPORTS_FROM エッジが復元される", () => {
    const libPath = path.join(tmpDir, "lib.ts");
    const appPath = path.join(tmpDir, "app.ts");
    writeFileSync(libPath, "export function libFn() {}");
    writeFileSync(appPath, `import { libFn } from "./lib.js";\nexport function useLib() { return libFn(); }`);

    // まず lib.ts を DB に登録して lib.ts::__file__ ノードを作成
    updateFile(db, libPath);
    // 次に app.ts を更新（lib.ts::__file__ が DB に存在するので IMPORTS_FROM エッジが生成される）
    updateFile(db, appPath);

    const edge = db
      .prepare("SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND kind = 'IMPORTS_FROM'")
      .get(`${appPath}::__file__`, `${libPath}::__file__`);
    expect(edge).toBeTruthy();
  });

  it("re-export を含む同一入力から full build と同じ IMPORTS_FROM エッジを生成する", () => {
    const targetPath = path.join(tmpDir, "target.ts");
    const namedPath = path.join(tmpDir, "named.ts");
    const barrelPath = path.join(tmpDir, "index.ts");
    const consumerPath = path.join(tmpDir, "consumer.ts");
    const tsconfigPath = path.join(tmpDir, "tsconfig.json");
    writeFileSync(targetPath, "export const target = 1;");
    writeFileSync(namedPath, "export const named = 2;");
    writeFileSync(
      barrelPath,
      'export * from "./target.js";\nexport { named } from "./named.js";'
    );
    writeFileSync(
      consumerPath,
      'import { target, named } from "./index.js";\nexport const value = target + named;'
    );
    writeFileSync(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
        include: ["*.ts"],
      })
    );

    buildFullGraph(db, [tsconfigPath]);
    const fullEdges = db
      .prepare("SELECT source_id, target_id, kind FROM edges WHERE kind = 'IMPORTS_FROM' ORDER BY source_id, target_id")
      .all();

    const incrementalDbPath = `/tmp/ts-review-graph-updater-incremental-${randomUUID()}.db`;
    const incrementalDb = openDb(incrementalDbPath);
    try {
      updateFile(incrementalDb, targetPath);
      updateFile(incrementalDb, namedPath);
      updateFile(incrementalDb, barrelPath);
      updateFile(incrementalDb, consumerPath);

      const incrementalEdges = incrementalDb
        .prepare("SELECT source_id, target_id, kind FROM edges WHERE kind = 'IMPORTS_FROM' ORDER BY source_id, target_id")
        .all();
      expect(fullEdges).toContainEqual({
        source_id: `${barrelPath}::__file__`,
        target_id: `${targetPath}::__file__`,
        kind: "IMPORTS_FROM",
      });
      expect(fullEdges).toContainEqual({
        source_id: `${barrelPath}::__file__`,
        target_id: `${namedPath}::__file__`,
        kind: "IMPORTS_FROM",
      });
      expect(incrementalEdges).toEqual(fullEdges);
    } finally {
      incrementalDb.close();
      for (const ext of ["", "-wal", "-shm"]) {
        const p = incrementalDbPath + ext;
        if (existsSync(p)) rmSync(p);
      }
    }
  });

  it("削除後に同名ファイルが同じ内容で再作成されたらグラフを更新する", () => {
    const filePath = path.join(tmpDir, "e.ts");
    const content = "export function revived() {}";
    writeFileSync(filePath, content);
    updateFile(db, filePath);

    // ファイルを削除してハッシュをクリア
    rmSync(filePath);
    updateFile(db, filePath);

    // 同じ内容で再作成 → ハッシュがないので 'updated' になる
    writeFileSync(filePath, content);
    const result = updateFile(db, filePath);

    expect(result).toBe("updated");
    const nodes = db.prepare("SELECT * FROM nodes WHERE file = ?").all(filePath);
    expect(nodes.length).toBeGreaterThan(0);
  });
});

describe("buildFullGraph", () => {
  it("barrel 経由で import するファイルを実体ファイルの blast radius に含める", () => {
    const targetPath = path.join(tmpDir, "target.ts");
    const barrelPath = path.join(tmpDir, "index.ts");
    const consumerPath = path.join(tmpDir, "consumer.ts");
    const tsconfigPath = path.join(tmpDir, "tsconfig.json");
    writeFileSync(targetPath, "export const target = 1;");
    writeFileSync(barrelPath, 'export * from "./target.js";');
    writeFileSync(
      consumerPath,
      'import { target } from "./index.js";\nexport const value = target;'
    );
    writeFileSync(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
        include: ["*.ts"],
      })
    );

    buildFullGraph(db, [tsconfigPath]);

    const affectedFiles = computeBlastRadius(db, targetPath, 2).map((node) => node.file);
    expect(affectedFiles).toContain(consumerPath);
  });

  it("複数 tsconfig のノードを単一 DB にマージする", () => {
    // フィクスチャ1: temp ディレクトリに a.ts
    const dir1 = path.join(os.tmpdir(), `ts-rg-fixture1-${randomUUID()}`);
    const dir2 = path.join(os.tmpdir(), `ts-rg-fixture2-${randomUUID()}`);
    try {
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
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("空配列を渡した場合はノードを挿入しない", () => {
    buildFullGraph(db, []);
    const count = (
      db.prepare("SELECT COUNT(*) as c FROM nodes").get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it("tsconfig 間クロス参照がある場合も FK 制約違反が起きない", () => {
    // parentDir/lib/lib.ts (libTsconfig)
    // parentDir/app/app.ts + app.test.ts (appTsconfig) — app.test.ts が "../lib/lib.js" を import
    // appTsconfig を tsconfig[0] に渡し、libTsconfig を tsconfig[1] にすることで
    // 旧コード(単一ループ)では tsconfig[0] のエッジ挿入時に lib.ts ノードが未存在 → FK 違反が発生した
    const parentDir = path.join(os.tmpdir(), `ts-rg-cross-${randomUUID()}`);
    const libDir = path.join(parentDir, "lib");
    const appDir = path.join(parentDir, "app");
    try {
      mkdirSync(libDir, { recursive: true });
      writeFileSync(path.join(libDir, "lib.ts"), "export function libFn() { return 1; }");
      writeFileSync(
        path.join(libDir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { target: "ES2022", module: "ES2022" }, include: ["lib.ts"] })
      );

      mkdirSync(appDir, { recursive: true });
      writeFileSync(path.join(appDir, "app.ts"), "export function appFn() { return 2; }");
      writeFileSync(
        path.join(appDir, "app.test.ts"),
        `import { appFn } from "./app.js";\nimport { libFn } from "../lib/lib.js";\nexport {};`
      );
      writeFileSync(
        path.join(appDir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { target: "ES2022", module: "ES2022" }, include: ["app.ts", "app.test.ts"] })
      );

      // tsconfig[0] = appTsconfig (HAS_TEST エッジが lib.ts を sourceId として参照)
      // tsconfig[1] = libTsconfig (lib.ts ノードの供給源)
      // FK 制約違反が起きなければ成功
      expect(() =>
        buildFullGraph(db, [
          path.join(appDir, "tsconfig.json"),
          path.join(libDir, "tsconfig.json"),
        ])
      ).not.toThrow();

      const appNode = db.prepare("SELECT * FROM nodes WHERE name = 'appFn'").get();
      expect(appNode).toBeTruthy();
      const libNode = db.prepare("SELECT * FROM nodes WHERE name = 'libFn'").get();
      expect(libNode).toBeTruthy();
      const hasTestEdge = db.prepare("SELECT * FROM edges WHERE kind = 'HAS_TEST'").get();
      expect(hasTestEdge).toBeTruthy();
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });
});
