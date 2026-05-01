import type { Db } from "@ts-review-graph/core";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function queryGraph(
  db: Db,
  args: Record<string, unknown>
): ToolResult {
  const from = args["from"] as string;
  const edgeKind = args["edge_kind"] as string | undefined;
  const direction = (args["direction"] as string) ?? "forward";
  const depth = Math.min(Number(args["depth"] ?? 1), 10); // 上限10

  const kindClause = edgeKind ? "AND e.kind = @edgeKind" : "";
  const traverseJoin =
    direction === "forward"
      ? "e.source_id = t.node_id"
      : "e.target_id = t.node_id";
  const selectNext =
    direction === "forward" ? "e.target_id" : "e.source_id";

  const sql = `
    WITH RECURSIVE traverse(node_id, depth) AS (
      SELECT id, 0 FROM nodes WHERE id = @from
      UNION ALL
      SELECT ${selectNext}, t.depth + 1
      FROM traverse t
      JOIN edges e ON ${traverseJoin}
      WHERE t.depth < @depth ${kindClause}
    )
    SELECT DISTINCT n.id, n.file, n.name, n.kind
    FROM traverse tr
    JOIN nodes n ON n.id = tr.node_id
    ORDER BY n.file
  `;

  // edgeKind がある場合とない場合でバインド変数を分ける
  const rows = edgeKind
    ? (db.prepare(sql).all({ from, depth, edgeKind }) as Array<{
        id: string;
        file: string;
        name: string;
        kind: string;
      }>)
    : (db.prepare(sql).all({ from, depth }) as Array<{
        id: string;
        file: string;
        name: string;
        kind: string;
      }>);

  const lines = rows.map((r) => `${r.id}  [${r.kind}]  ${r.file}`);
  return {
    content: [
      {
        type: "text",
        text: `Query result (from=${from}, direction=${direction}, depth=${depth}):\n${lines.join("\n") || "(empty)"}`,
      },
    ],
  };
}
