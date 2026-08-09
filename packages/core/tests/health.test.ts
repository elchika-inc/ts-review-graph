import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { buildFullGraph, updateFile } from "../src/updater.js";
import { writeMeta, SCHEMA_VERSION } from "../src/meta.js";
import { checkGraphHealth } from "../src/health.js";
import { rmSync, existsSync, writeFileSync, mkdirSync, utimesSync, symlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

let db: ReturnType<typeof openDb>;
let testDb: string;
let root: string;

// tsconfig と最小のソースを持つプロジェクトを作り、config.json も書く
function makeProject(): string {
  const dir = path.join(os.tmpdir(), `ts-rg-health-${randomUUID()}`);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, ".ts-review-graph"), { recursive: true });
  writeFileSync(path.join(dir, "src/a.ts"), "export const a = 1;\n");
  const old = new Date("2020-01-01T00:00:00.000Z");
  utimesSync(path.join(dir, "src/a.ts"), old, old);
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext" }, include: ["src"] })
  );
  writeFileSync(
    path.join(dir, ".ts-review-graph/config.json"),
    JSON.stringify({ tsconfigs: ["tsconfig.json"] })
  );
  return dir;
}

beforeEach(() => {
  testDb = `/tmp/ts-review-graph-health-test-${randomUUID()}.db`;
  db = openDb(testDb);
  root = makeProject();
});

afterEach(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = testDb + ext;
    if (existsSync(p)) rmSync(p);
  }
  rmSync(root, { recursive: true, force: true });
});

describe("checkGraphHealth", () => {
  it("meta が無い DB は legacy_schema で mismatch", () => {
    const h = checkGraphHealth(db, root);
    expect(h.status).toBe("mismatch");
    expect(h.status === "mismatch" && h.reason).toBe("legacy_schema");
  });

  it("schema_version が古い DB は legacy_schema で mismatch", () => {
    buildFullGraph(db, [path.join(root, "tsconfig.json")], root);
    writeMeta(db, {
      schemaVersion: "1",
      tsconfigs: ["tsconfig.json"],
      builtAt: Date.now(),
      builtRoot: root,
    });
    const h = checkGraphHealth(db, root);
    expect(h.status === "mismatch" && h.reason).toBe("legacy_schema");
  });

  it("構築直後は ok", () => {
    buildFullGraph(db, [path.join(root, "tsconfig.json")], root);
    expect(checkGraphHealth(db, root).status).toBe("ok");
    for (const configured of ["./tsconfig.json", path.join(root, "tsconfig.json")]) {
      writeFileSync(
        path.join(root, ".ts-review-graph/config.json"),
        JSON.stringify({ tsconfigs: [configured] })
      );
      expect(checkGraphHealth(db, root).status).toBe("ok");
    }
  });

  it("config.json の tsconfigs が増えると tsconfig_drift で mismatch", () => {
    buildFullGraph(db, [path.join(root, "tsconfig.json")], root);
    writeFileSync(
      path.join(root, ".ts-review-graph/config.json"),
      JSON.stringify({ tsconfigs: ["tsconfig.json", "apps/web/tsconfig.json"] })
    );
    const h = checkGraphHealth(db, root);
    expect(h.status === "mismatch" && h.reason).toBe("tsconfig_drift");
  });

  it("config.json が無い場合も tsconfig_drift で mismatch（検証不能は通さない）", () => {
    buildFullGraph(db, [path.join(root, "tsconfig.json")], root);
    rmSync(path.join(root, ".ts-review-graph/config.json"));
    const h = checkGraphHealth(db, root);
    expect(h.status === "mismatch" && h.reason).toBe("tsconfig_drift");
  });

  it("ファイルを更新すると drift になる", () => {
    buildFullGraph(db, [path.join(root, "tsconfig.json")], root);
    const target = path.join(root, "src/a.ts");
    const touchedAt = new Date();
    utimesSync(target, touchedAt, touchedAt);
    const h = checkGraphHealth(db, root);
    expect(h.status).toBe("drift");
    expect(h.status === "drift" && h.staleFiles).toBe(1);
    expect(h.status === "drift" && h.totalFiles).toBeGreaterThan(0);

    expect(updateFile(db, target, root)).toBe("skipped");
    expect(checkGraphHealth(db, root)).toEqual({ status: "ok" });
  });

  it("グラフ登録済みファイルが削除されると drift に数える", () => {
    buildFullGraph(db, [path.join(root, "tsconfig.json")], root);
    rmSync(path.join(root, "src/a.ts"));
    const h = checkGraphHealth(db, root);
    expect(h.status).toBe("drift");
    expect(h.status === "drift" && h.staleFiles).toBe(1);

    const loopPath = path.join(root, "loop.ts");
    symlinkSync("loop.ts", loopPath);
    db.prepare(
      "INSERT INTO file_hashes (file, hash, updated_at) VALUES (?, ?, ?)"
    ).run("loop.ts", "loop", Date.now());
    expect(() => checkGraphHealth(db, root)).toThrow();
  });
});
