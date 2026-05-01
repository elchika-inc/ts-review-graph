import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

const DDL = `
CREATE TABLE IF NOT EXISTS nodes (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,
  name      TEXT NOT NULL,
  file      TEXT NOT NULL,
  line      INTEGER NOT NULL,
  signature TEXT,
  type_refs TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS edges (
  source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id, kind)
);

CREATE TABLE IF NOT EXISTS file_hashes (
  file       TEXT PRIMARY KEY,
  hash       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id, kind);
CREATE INDEX IF NOT EXISTS idx_nodes_file   ON nodes(file);
`;

export function openDb(dbPath: string): Db {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(DDL);
  return db;
}
