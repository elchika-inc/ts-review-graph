import type { Db } from "./db.js";

export interface BlastNode {
  file: string;
  reason: string;
  depth: number;
}

// 逆方向 BFS: 変更ファイルに依存しているファイルを探す
// エッジ意味: source が target を依存している
// → target を変更したとき source が影響を受ける → source を逆探索
//
// UNION (not UNION ALL): SQLite は完全な行タプル (node_id, depth, reason) で重複除去する。
// 同一 node_id でも depth や reason が異なれば別行として扱われるため、UNION だけでは
// サイクルグラフのノード再訪問を防げない。:max_depth が実質的なサイクル終端として機能する。
// 最終出力の重複は JS レイヤーの seen.has(n.file) で排除する。
const REVERSE_BFS_SQL = `
WITH RECURSIVE blast(node_id, depth, reason) AS (
  SELECT id, 0, 'changed'
  FROM nodes
  WHERE file = :changed_file

  UNION

  SELECT e.source_id, b.depth + 1, e.kind
  FROM blast b
  JOIN edges e ON e.target_id = b.node_id
  WHERE b.depth < :max_depth
    AND e.kind IN ('IMPORTS_FROM', 'TYPED_BY', 'IMPLEMENTS', 'EXTENDS')
)
SELECT DISTINCT n.file, b.reason, b.depth
FROM blast b
JOIN nodes n ON n.id = b.node_id
ORDER BY b.depth, n.file
`;

// HAS_TEST は前方探索: source=実装, target=テスト
const TEST_LOOKUP_SQL = `
SELECT DISTINCT n.file, 'HAS_TEST' as reason, 1 as depth
FROM nodes impl
JOIN edges e ON e.source_id = impl.id AND e.kind = 'HAS_TEST'
JOIN nodes n ON n.id = e.target_id
WHERE impl.file = :changed_file
`;

const FORWARD_DEPS_SQL = `
SELECT DISTINCT n.file, 'direct import' as reason, 1 as depth
FROM nodes src
JOIN edges e ON e.source_id = src.id
  AND e.kind = 'IMPORTS_FROM'
JOIN nodes n ON n.id = e.target_id
WHERE src.file = :changed_file
  AND n.file != :changed_file
`;

// Db インスタンスごとのステートメントキャッシュ — prepare() の再コンパイルを防ぐ
const stmtCache = new WeakMap<Db, {
  reverseBfs: ReturnType<Db["prepare"]>;
  testLookup: ReturnType<Db["prepare"]>;
  forwardDeps: ReturnType<Db["prepare"]>;
}>();

function getStmts(db: Db) {
  let stmts = stmtCache.get(db);
  if (!stmts) {
    stmts = {
      reverseBfs: db.prepare(REVERSE_BFS_SQL),
      testLookup: db.prepare(TEST_LOOKUP_SQL),
      forwardDeps: db.prepare(FORWARD_DEPS_SQL),
    };
    stmtCache.set(db, stmts);
  }
  return stmts;
}

export function computeBlastRadius(
  db: Db,
  changedFile: string,
  maxDepth: number
): BlastNode[] {
  const { reverseBfs, testLookup } = getStmts(db);

  const reverseNodes = reverseBfs
    .all({ changed_file: changedFile, max_depth: maxDepth }) as BlastNode[];

  const testNodes = testLookup
    .all({ changed_file: changedFile }) as BlastNode[];

  // 重複排除（ファイルパスをキーに先着優先）
  const seen = new Map<string, BlastNode>();
  for (const n of [...reverseNodes, ...testNodes]) {
    if (!seen.has(n.file)) seen.set(n.file, n);
  }

  return Array.from(seen.values());
}

export function DEPTH_FOR_MODE(
  mode: "review" | "implement" | "debug"
): number {
  const depths: Record<string, number> = { review: 2, implement: 3, debug: 5 };
  return depths[mode] ?? 2;
}

export function computeForwardDeps(db: Db, changedFile: string): BlastNode[] {
  const { forwardDeps } = getStmts(db);
  return forwardDeps
    .all({ changed_file: changedFile }) as BlastNode[];
}
