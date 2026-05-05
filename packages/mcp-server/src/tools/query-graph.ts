import type { Db } from "@elchika-inc/ts-review-graph-core";
import type { ToolResult } from "./types.js";
import { resolveFilePath } from "./resolve-path.js";

const VALID_EDGE_KINDS = new Set(["IMPORTS_FROM", "TYPED_BY", "IMPLEMENTS", "EXTENDS", "HAS_TEST"]);
const MAX_RESULTS = 200;

// direction × edgeKind存在 の4組を Db インスタンスごとにキャッシュ — prepare の再コンパイルを防ぐ
type QueryGraphStmts = {
  forwardWithKind: ReturnType<Db["prepare"]>;
  forwardNoKind: ReturnType<Db["prepare"]>;
  reverseWithKind: ReturnType<Db["prepare"]>;
  reverseNoKind: ReturnType<Db["prepare"]>;
};
const queryGraphStmtCache = new WeakMap<Db, QueryGraphStmts>();

function getQueryGraphStmts(db: Db): QueryGraphStmts {
  let stmts = queryGraphStmtCache.get(db);
  if (!stmts) {
    const makeSQL = (dir: "forward" | "reverse", withKind: boolean) => {
      const selectNext = dir === "forward" ? "e.target_id" : "e.source_id";
      const traverseJoin = dir === "forward" ? "e.source_id = t.node_id" : "e.target_id = t.node_id";
      const kindClause = withKind ? "AND e.kind = @edgeKind" : "";
      return `
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
    };
    stmts = {
      forwardWithKind: db.prepare(makeSQL("forward", true)),
      forwardNoKind: db.prepare(makeSQL("forward", false)),
      reverseWithKind: db.prepare(makeSQL("reverse", true)),
      reverseNoKind: db.prepare(makeSQL("reverse", false)),
    };
    queryGraphStmtCache.set(db, stmts);
  }
  return stmts;
}

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

  let resolvedFrom: string;
  try {
    resolvedFrom = resolveFilePath(from);
  } catch (err) {
    return {
      content: [{ type: "text", text: `無効なファイルパス: ${err instanceof Error ? err.message : String(err)}` }],
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

  const rawDirection = args["direction"];
  if (rawDirection !== undefined && rawDirection !== "forward" && rawDirection !== "reverse") {
    return {
      content: [{ type: "text", text: `direction must be "forward" or "reverse"` }],
      isError: true,
    };
  }
  const direction: "forward" | "reverse" = rawDirection === "reverse" ? "reverse" : "forward";

  const rawDepth = Number(args["depth"] ?? 3);
  const depth = Math.floor(Math.min(Math.max(1, Number.isFinite(rawDepth) ? rawDepth : 3), 10)); // 整数・最小1・デフォルト3・上限10

  let stmts: QueryGraphStmts;
  try {
    stmts = getQueryGraphStmts(db);
  } catch (err) {
    return {
      content: [{ type: "text", text: `クエリの準備に失敗しました: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
  const stmt = direction === "forward"
    ? (edgeKind ? stmts.forwardWithKind : stmts.forwardNoKind)
    : (edgeKind ? stmts.reverseWithKind : stmts.reverseNoKind);

  let rows: Array<{ id: string; file: string; name: string; kind: string }>;
  try {
    rows = edgeKind
      ? (stmt.all({ from: resolvedFrom, depth, edgeKind }) as typeof rows)
      : (stmt.all({ from: resolvedFrom, depth }) as typeof rows);
  } catch (err) {
    return {
      content: [{ type: "text", text: `グラフクエリに失敗しました: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }

  const sanitize = (s: string) => s.replace(/[\r\n]/g, "");
  const truncated = rows.length > MAX_RESULTS;
  const display = truncated ? rows.slice(0, MAX_RESULTS) : rows;
  const lines = display.map((r) => `${sanitize(r.file)}::${sanitize(r.name)}  [${sanitize(r.kind)}]`);
  if (truncated) lines.push(`... (truncated at ${MAX_RESULTS} results — narrow with edge_kind or reduce depth)`);

  return {
    content: [
      {
        type: "text",
        text: `Query result (from=${sanitize(from)}, direction=${direction}, depth=${depth}):\n${lines.join("\n") || "(empty)"}`,
      },
    ],
  };
}
