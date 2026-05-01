import type { Db } from "./db.js";

export interface BlastNode {
  file: string;
  reason: string;
  depth: number;
}

// 逆方向 BFS: 変更ファイルに依存しているファイルを探す
// エッジ意味: source が target を依存している
// → target を変更したとき source が影響を受ける → source を逆探索
const REVERSE_BFS_SQL = `
WITH RECURSIVE blast(node_id, depth, reason) AS (
  SELECT id, 0, 'changed'
  FROM nodes
  WHERE file = :changed_file

  UNION ALL

  SELECT e.source_id, b.depth + 1, e.kind
  FROM blast b
  JOIN edges e ON e.target_id = b.node_id
  WHERE b.depth < :max_depth
    AND e.kind IN ('CALLS', 'IMPORTS_FROM', 'TYPED_BY', 'IMPLEMENTS', 'EXTENDS')
)
SELECT DISTINCT n.file, b.reason, b.depth
FROM blast b
JOIN nodes n ON n.id = b.node_id
ORDER BY b.depth, n.file
`;

// HAS_TEST は前方探索: source=実装, target=テスト
const TEST_LOOKUP_SQL = `
SELECT DISTINCT n.file, 'HAS_TEST' as reason, 0 as depth
FROM nodes impl
JOIN edges e ON e.source_id = impl.id AND e.kind = 'HAS_TEST'
JOIN nodes n ON n.id = e.target_id
WHERE impl.file = :changed_file
`;

export function computeBlastRadius(
  db: Db,
  changedFile: string,
  maxDepth: number
): BlastNode[] {
  const reverseNodes = db
    .prepare(REVERSE_BFS_SQL)
    .all({ changed_file: changedFile, max_depth: maxDepth }) as BlastNode[];

  const testNodes = db
    .prepare(TEST_LOOKUP_SQL)
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
