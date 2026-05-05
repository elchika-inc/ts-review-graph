import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

let TEST_DB: string;

beforeEach(() => {
  TEST_DB = `/tmp/ts-review-graph-test-${randomUUID()}.db`;
});

afterEach(() => {
  for (const ext of ["", "-wal", "-shm"]) {
    const p = TEST_DB + ext;
    if (existsSync(p)) rmSync(p);
  }
});

describe("openDb", () => {
  it("テーブルが存在する", () => {
    const db = openDb(TEST_DB);
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: any) => r.name);
      expect(tables).toContain("nodes");
      expect(tables).toContain("edges");
      expect(tables).toContain("file_hashes");
    } finally {
      db.close();
    }
  });

  it("nodes に INSERT → edges の CASCADE DELETE が機能する", () => {
    const db = openDb(TEST_DB);
    try {
      db.prepare(
        "INSERT INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
      ).run("n1", "function", "foo", "a.ts", 1, "[]");
      db.prepare(
        "INSERT INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
      ).run("n2", "function", "bar", "b.ts", 1, "[]");
      db.prepare(
        "INSERT INTO edges (source_id, target_id, kind) VALUES (?,?,?)"
      ).run("n1", "n2", "CALLS");

      db.prepare("DELETE FROM nodes WHERE id = ?").run("n1");

      const edge = db
        .prepare("SELECT * FROM edges WHERE source_id = ?")
        .get("n1");
      expect(edge).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("WAL モードが有効", () => {
    const db = openDb(TEST_DB);
    try {
      const row = db.prepare("PRAGMA journal_mode").get() as any;
      expect(row.journal_mode).toBe("wal");
    } finally {
      db.close();
    }
  });
});
