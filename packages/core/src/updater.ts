import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
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
  const insertEdge = db.prepare(INSERT_EDGE);
  const deleteNodesByFile = db.prepare("DELETE FROM nodes WHERE file = ?");
  const selectNodeExists = db.prepare("SELECT 1 FROM nodes WHERE id = ?");
  const upsertHash = db.prepare(UPSERT_HASH);

  const run = db.transaction(() => {
    // 古いノードを削除（ON DELETE CASCADE がエッジも消す）
    deleteNodesByFile.run(filePath);

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

    // IMPORTS_FROM エッジを復元（相対インポートのみ）
    // Note: TYPED_BY/IMPLEMENTS/EXTENDS/HAS_TEST はクロスファイル解決が必要なため
    // 次回フル build 時に復元される
    for (const decl of sf.getImportDeclarations()) {
      const moduleSpec = decl.getModuleSpecifierValue();
      // 相対パスのみ解決（npm パッケージは除外）
      if (!moduleSpec.startsWith(".")) continue;

      const base = resolvePath(dirname(filePath), moduleSpec);
      const candidates = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}/index.ts`,
        `${base}/index.tsx`,
      ];

      for (const candidate of candidates) {
        // 対象ノードが DB に存在すれば IMPORTS_FROM エッジを挿入
        const targetNodeId = `${candidate}::__file__`;
        const exists = selectNodeExists.get(targetNodeId);
        if (exists) {
          insertEdge.run({
            sourceId: fileNodeId,
            targetId: targetNodeId,
            kind: "IMPORTS_FROM",
          });
          break;
        }
      }
    }

    // ハッシュ UPSERT
    upsertHash.run({
      file: filePath,
      hash: newHash,
      updatedAt: Date.now(),
    });
  });

  run();
  return "updated";
}

export function buildFullGraph(db: Db, tsconfigPaths: string[]): void {
  const insertNode = db.prepare(INSERT_NODE);
  const insertEdge = db.prepare(INSERT_EDGE);
  const upsertHash = db.prepare(UPSERT_HASH);

  const deleteEdges = db.prepare("DELETE FROM edges");
  const deleteNodes = db.prepare("DELETE FROM nodes");
  const deleteHashes = db.prepare("DELETE FROM file_hashes");

  const now = Date.now();

  // analyzeProject はトランザクション外で実行（TS Compiler API は純粋な計算、DB アクセスなし）
  // 全 tsconfig の解析が終わってから一括 INSERT することで書き込みロック時間を最小化する
  const allResults = tsconfigPaths.map((p) => analyzeProject(p));

  const runAll = db.transaction(() => {
    deleteEdges.run();
    deleteNodes.run();
    deleteHashes.run();

    for (const { nodes, edges, fileHashes } of allResults) {
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
    }
  });

  runAll();
}
