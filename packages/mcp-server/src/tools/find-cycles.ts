import type { Db } from "@elchika-inc/ts-review-graph-core";
import type { ToolResult } from "./types.js";

const DEFAULT_MAX_CYCLES = 20;
const MAX_MAX_CYCLES = 100;

const FIND_CYCLES_SQL = `
WITH RECURSIVE
file_edges(source_rowid, target_rowid) AS (
  SELECT DISTINCT source.rowid, target.rowid
  FROM edges e
  JOIN nodes source ON source.id = e.source_id
  JOIN nodes target ON target.id = e.target_id
  WHERE e.kind = 'IMPORTS_FROM'
    AND source.kind IN ('file', 'test')
    AND target.kind IN ('file', 'test')
),
file_count(value) AS (
  SELECT COUNT(*) FROM nodes WHERE kind IN ('file', 'test')
),
walk(start_rowid, current_rowid, path, depth) AS (
  SELECT
    source_rowid,
    target_rowid,
    printf(',%d,%d,', source_rowid, target_rowid),
    1
  FROM file_edges
  WHERE target_rowid >= source_rowid

  UNION ALL

  SELECT
    walk.start_rowid,
    file_edges.target_rowid,
    walk.path || printf('%d,', file_edges.target_rowid),
    walk.depth + 1
  FROM walk
  JOIN file_edges ON file_edges.source_rowid = walk.current_rowid
  WHERE walk.current_rowid != walk.start_rowid
    AND walk.depth < (SELECT value FROM file_count)
    AND (
      file_edges.target_rowid = walk.start_rowid
      OR (
        file_edges.target_rowid > walk.start_rowid
        AND instr(walk.path, printf(',%d,', file_edges.target_rowid)) = 0
      )
    )
)
SELECT path
FROM walk
WHERE current_rowid = start_rowid
ORDER BY path
LIMIT @queryLimit
`;

type CycleRow = { path: string };
type FileRow = { rowId: number; file: string };
interface NoParamAllStmt { all(): unknown[] }

const stmtCache = new WeakMap<Db, {
  findCycles: ReturnType<Db["prepare"]>;
  listFiles: NoParamAllStmt;
}>();

function getStmts(db: Db) {
  let stmts = stmtCache.get(db);
  if (!stmts) {
    stmts = {
      findCycles: db.prepare(FIND_CYCLES_SQL),
      listFiles: db.prepare(
        "SELECT rowid AS rowId, file FROM nodes WHERE kind IN ('file', 'test')"
      ) as unknown as NoParamAllStmt,
    };
    stmtCache.set(db, stmts);
  }
  return stmts;
}

export function findCycles(db: Db, args: Record<string, unknown>): ToolResult {
  const rawMaxCycles = args["max_cycles"] ?? DEFAULT_MAX_CYCLES;
  if (
    typeof rawMaxCycles !== "number" ||
    !Number.isInteger(rawMaxCycles) ||
    rawMaxCycles < 1 ||
    rawMaxCycles > MAX_MAX_CYCLES
  ) {
    return {
      content: [
        {
          type: "text",
          text: `max_cycles must be an integer between 1 and ${MAX_MAX_CYCLES}`,
        },
      ],
      isError: true,
    };
  }

  try {
    const { findCycles, listFiles } = getStmts(db);
    const rows = findCycles.all({ queryLimit: rawMaxCycles + 1 }) as CycleRow[];
    if (rows.length === 0) {
      return {
        content: [{ type: "text", text: "No circular import cycles found." }],
      };
    }

    const filesByRowId = new Map(
      (listFiles.all() as FileRow[]).map((row) => [row.rowId, row.file])
    );
    const truncated = rows.length > rawMaxCycles;
    const cycles = rows.slice(0, rawMaxCycles).map((row) =>
      row.path
        .split(",")
        .filter(Boolean)
        .map(Number)
        .map((rowId) => filesByRowId.get(rowId) ?? `[missing node ${rowId}]`)
    );
    const lines = cycles.map(
      (cycle, index) =>
        `${index + 1}. ${cycle.map((file) => file.replace(/[\r\n]/g, "")).join(" -> ")}`
    );
    if (truncated) {
      lines.push(`... (truncated at ${rawMaxCycles} cycle${rawMaxCycles === 1 ? "" : "s"})`);
    }

    return {
      content: [
        {
          type: "text",
          text: `Circular import cycles (${cycles.length}):\n${lines.join("\n")}`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `循環依存の検出に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}
