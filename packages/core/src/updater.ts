import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { Project } from "ts-morph";
import type { Db } from "./db.js";
import { analyzeProject } from "./analyzer.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function getStoredHash(db: Db, file: string): string | undefined {
  const row = db
    .prepare("SELECT hash FROM file_hashes WHERE file = ?")
    .get(file) as { hash: string } | undefined;
  return row?.hash;
}

const INSERT_NODE = `
  INSERT OR REPLACE INTO nodes (id, kind, name, file, line, signature, type_refs)
  VALUES (@id, @kind, @name, @file, @line, @signature, @typeRefs)
`;

const INSERT_EDGE = `
  INSERT OR IGNORE INTO edges (source_id, target_id, kind)
  VALUES (@sourceId, @targetId, @kind)
`;

const UPSERT_HASH = `
  INSERT INTO file_hashes (file, hash, updated_at)
  VALUES (@file, @hash, @updatedAt)
  ON CONFLICT(file) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at
`;

export function updateFile(db: Db, filePath: string): "skipped" | "updated" {
  if (!existsSync(filePath)) return "skipped";

  const content = readFileSync(filePath, "utf-8");
  const newHash = sha256(content);
  const oldHash = getStoredHash(db, filePath);

  if (oldHash === newHash) return "skipped";

  // ts-morph 解析はトランザクション外（純粋な計算、DBアクセスなし）
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const sf = project.addSourceFileAtPath(filePath);

  const insertNode = db.prepare(INSERT_NODE);

  const run = db.transaction(() => {
    // 古いノードを削除（ON DELETE CASCADE がエッジも消す）
    db.prepare("DELETE FROM nodes WHERE file = ?").run(filePath);

    // ファイルノード
    const fileNodeId = `${filePath}::__file__`;
    insertNode.run({
      id: fileNodeId,
      kind: "file",
      name: filePath.split("/").pop() ?? filePath,
      file: filePath,
      line: 1,
      signature: null,
      typeRefs: "[]",
    });

    // 関数ノード
    for (const fn of sf.getFunctions()) {
      const name = fn.getName();
      if (!name) continue;
      insertNode.run({
        id: `${filePath}::${name}`,
        kind: "function",
        name,
        file: filePath,
        line: fn.getStartLineNumber(),
        signature: null,
        typeRefs: "[]",
      });
    }

    // クラスノード
    for (const cls of sf.getClasses()) {
      const name = cls.getName();
      if (!name) continue;
      insertNode.run({
        id: `${filePath}::${name}`,
        kind: "class",
        name,
        file: filePath,
        line: cls.getStartLineNumber(),
        signature: null,
        typeRefs: "[]",
      });
    }

    // インターフェースノード
    for (const iface of sf.getInterfaces()) {
      insertNode.run({
        id: `${filePath}::${iface.getName()}`,
        kind: "interface",
        name: iface.getName(),
        file: filePath,
        line: iface.getStartLineNumber(),
        signature: null,
        typeRefs: "[]",
      });
    }

    // ハッシュ UPSERT
    db.prepare(UPSERT_HASH).run({
      file: filePath,
      hash: newHash,
      updatedAt: Date.now(),
    });
  });

  run();
  return "updated";
}

export function buildFullGraph(db: Db, tsconfigPath: string): void {
  const { nodes, edges, fileHashes } = analyzeProject(tsconfigPath);

  const insertNode = db.prepare(INSERT_NODE);
  const insertEdge = db.prepare(INSERT_EDGE);
  const upsertHash = db.prepare(UPSERT_HASH);

  const now = Date.now();

  const runAll = db.transaction(() => {
    for (const n of nodes) {
      insertNode.run({
        id: n.id,
        kind: n.kind,
        name: n.name,
        file: n.file,
        line: n.line,
        signature: n.signature ?? null,
        typeRefs: JSON.stringify(n.typeRefs),
      });
    }
    for (const e of edges) {
      insertEdge.run({
        sourceId: e.sourceId,
        targetId: e.targetId,
        kind: e.kind,
      });
    }
    for (const [file, hash] of fileHashes) {
      upsertHash.run({ file, hash, updatedAt: now });
    }
  });

  runAll();
}
