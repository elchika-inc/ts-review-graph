import type { Db } from "@ts-review-graph/core";
import type { ToolResult } from "./types.js";

const VALID_EDGE_KINDS = new Set(["IMPORTS_FROM", "TYPED_BY", "IMPLEMENTS", "EXTENDS", "HAS_TEST"]);
const MAX_RESULTS = 200;

export function queryGraph(
  db: Db,
  args: Record<string, unknown>
): ToolResult {
  const from = args["from"];
  if (typeof from !== "string" || from.trim() === "") {
    return {
      content: [{ type: "text", text: "from must be a non-empty string" }],
      isError: true,
    };
  }

  const rawEdgeKind = args["edge_kind"];
  if (rawEdgeKind !== undefined && (typeof rawEdgeKind !== "string" || !VALID_EDGE_KINDS.has(rawEdgeKind))) {
    return {
      content: [{ type: "text", text: `edge_kind must be one of: ${[...VALID_EDGE_KINDS].join(", ")}` }],
      isError: true,
    };
  }
  const edgeKind = typeof rawEdgeKind === "string" ? rawEdgeKind : undefined;

  const direction: "forward" | "reverse" =
    args["direction"] === "reverse" ? "reverse" : "forward";

  const rawDepth = Number(args["depth"] ?? 3);
  const depth = Math.min(Number.isFinite(rawDepth) ? rawDepth : 3, 10); // デフォルト3、上限10

  const kindClause = edgeKind ? "AND e.kind = @edgeKind" : "";
  const traverseJoin =
    direction === "forward"
      ? "e.source_id = t.node_id"
      : "e.target_id = t.node_id";
  const selectNext =
    direction === "forward" ? "e.target_id" : "e.source_id";

  // file でシード — from はファイルパス。id ではなく file でルックアップする
  const sql = `
    WITH RECURSIVE traverse(node_id, depth) AS (
      SELECT id, 0 FROM nodes WHERE file = @from
      UNION
      SELECT ${selectNext}, t.depth + 1
      FROM traverse t
      JOIN edges e ON ${traverseJoin}
      WHERE t.depth < @depth ${kindClause}
    )
    SELECT DISTINCT n.id, n.file, n.name, n.kind
    FROM traverse tr
    JOIN nodes n ON n.id = tr.node_id
    ORDER BY n.file
    LIMIT ${MAX_RESULTS + 1}
  `;

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

  const truncated = rows.length > MAX_RESULTS;
  const display = truncated ? rows.slice(0, MAX_RESULTS) : rows;
  const lines = display.map((r) => `${r.id}  [${r.kind}]  ${r.file}`);
  if (truncated) lines.push(`... (truncated at ${MAX_RESULTS} results — narrow with edge_kind or reduce depth)`);

  return {
    content: [
      {
        type: "text",
        text: `Query result (from=${from}, direction=${direction}, depth=${depth}):\n${lines.join("\n") || "(empty)"}`,
      },
    ],
  };
}
