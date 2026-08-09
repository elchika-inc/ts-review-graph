import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { writeMeta, readMeta, SCHEMA_VERSION } from "../src/meta.js";
import { rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

let testDb: string;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  testDb = `/tmp/ts-review-graph-meta-test-${randomUUID()}.db`;
  db = openDb(testDb);
});

afterEach(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = testDb + ext;
    if (existsSync(p)) rmSync(p);
  }
});

describe("meta", () => {
  it("書き込んだ meta を読み戻せる", () => {
    writeMeta(db, {
      schemaVersion: SCHEMA_VERSION,
      tsconfigs: ["apps/api/tsconfig.json", "packages/db/tsconfig.json"],
      builtAt: 1700000000000,
      builtRoot: "/repo",
    });
    const m = readMeta(db);
    expect(m).not.toBeNull();
    expect(m!.schemaVersion).toBe(SCHEMA_VERSION);
    expect(m!.tsconfigs).toEqual(["apps/api/tsconfig.json", "packages/db/tsconfig.json"]);
    expect(m!.builtAt).toBe(1700000000000);
    expect(m!.builtRoot).toBe("/repo");
  });

  it("tsconfigs はソートして保存される", () => {
    writeMeta(db, {
      schemaVersion: SCHEMA_VERSION,
      tsconfigs: ["b/tsconfig.json", "a/tsconfig.json"],
      builtAt: 1,
      builtRoot: "/repo",
    });
    expect(readMeta(db)!.tsconfigs).toEqual(["a/tsconfig.json", "b/tsconfig.json"]);
  });

  it("meta が空の DB では null を返す", () => {
    expect(readMeta(db)).toBeNull();
  });

  it("二重書き込みしても最後の値が残る", () => {
    writeMeta(db, { schemaVersion: SCHEMA_VERSION, tsconfigs: ["a.json"], builtAt: 1, builtRoot: "/x" });
    writeMeta(db, { schemaVersion: SCHEMA_VERSION, tsconfigs: ["b.json"], builtAt: 2, builtRoot: "/y" });
    const m = readMeta(db)!;
    expect(m.tsconfigs).toEqual(["b.json"]);
    expect(m.builtAt).toBe(2);
    expect(m.builtRoot).toBe("/y");
  });

  it("SCHEMA_VERSION は '2'", () => {
    expect(SCHEMA_VERSION).toBe("2");
  });
});
