import type { Db } from "@elchika-inc/ts-review-graph-core";
import type { ToolResult } from "./types.js";

const MAX_TYPE_RESULTS = 500;

// LIKE クエリのステートメントを Db インスタンスごとにキャッシュ
const typeUsagesStmtCache = new WeakMap<Db, ReturnType<Db["prepare"]>>();
function getTypeUsagesStmt(db: Db) {
  let stmt = typeUsagesStmtCache.get(db);
  if (!stmt) {
    stmt = db.prepare(
      `SELECT DISTINCT n.file, n.name, n.kind
       FROM nodes n
       WHERE n.type_refs LIKE ? ESCAPE '\\'
       ORDER BY n.file
       LIMIT ${MAX_TYPE_RESULTS + 1}`
    );
    typeUsagesStmtCache.set(db, stmt);
  }
  return stmt;
}

export function getTypeUsages(
  db: Db,
  args: Record<string, unknown>
): ToolResult {
  const typeName = args["type_name"];
  if (typeof typeName !== "string" || typeName.trim() === "") {
    return {
      content: [{ type: "text", text: "type_name must be a non-empty string" }],
      isError: true,
    };
  }

  const escaped = typeName.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  let rows: Array<{ file: string; name: string; kind: string }>;
  try {
    rows = getTypeUsagesStmt(db).all(`%::${escaped}%`) as typeof rows;
  } catch (err) {
    return {
      content: [{ type: "text", text: `型使用箇所の検索に失敗しました: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }

  const safeTypeName = typeName.replace(/[\r\n]/g, "");
  const truncated = rows.length > MAX_TYPE_RESULTS;
  const display = truncated ? rows.slice(0, MAX_TYPE_RESULTS) : rows;
  const lines = display.map((r) => `${r.file.replace(/[\r\n]/g, "")}::${r.name.replace(/[\r\n]/g, "")}  [${r.kind}]`);
  if (truncated) lines.push(`... (truncated at ${MAX_TYPE_RESULTS} results — use a more specific type name)`);
  return {
    content: [
      {
        type: "text",
        text:
          lines.length > 0
            ? `Usages of type '${safeTypeName}':\n${lines.join("\n")}`
            : `No usages found for type '${safeTypeName}'`,
      },
    ],
  };
}
