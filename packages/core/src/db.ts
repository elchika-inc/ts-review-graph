import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
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
  -- target_id には意図的に REFERENCES を付けない。
  -- 増分更新でファイルAのノードを削除するとき、source が A であるエッジだけを
  -- CASCADE で消したい。他ファイルから A を target にしているエッジは残す必要がある
  -- (削除ファイルのブラスト半径計算に使うため)。
  -- target_id に CASCADE を付けると、A のノード削除時に B→A エッジまで消えてしまう。
  target_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id, kind)
);

CREATE TABLE IF NOT EXISTS file_hashes (
  file       TEXT PRIMARY KEY,
  hash       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id, kind);
-- source_id を含めてカバリングインデックス化 — REVERSE BFS の JOIN がテーブルルックアップなしで完結する
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id, kind, source_id);
CREATE INDEX IF NOT EXISTS idx_nodes_file   ON nodes(file);
`;

export function openDb(dbPath: string): Db {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(DDL);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
