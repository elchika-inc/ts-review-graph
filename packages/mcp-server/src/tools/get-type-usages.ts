import type { Db } from "@ts-review-graph/core";
import type { ToolResult } from "./types.js";

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
       LIMIT 501`
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
    rows = getTypeUsagesStmt(db).all(`%${escaped}%`) as typeof rows;
  } catch (err) {
    return {
      content: [{ type: "text", text: `型使用箇所の検索に失敗しました: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }

  const truncated = rows.length > 500;
  const display = truncated ? rows.slice(0, 500) : rows;
  const lines = display.map((r) => `${r.file}::${r.name}  [${r.kind}]`);
  if (truncated) lines.push(`... (500件で打ち切り — より具体的な型名で再検索してください)`);
  return {
    content: [
      {
        type: "text",
        text:
          lines.length > 0
            ? `Usages of type '${typeName}':\n${lines.join("\n")}`
            : `No usages found for type '${typeName}'`,
      },
    ],
  };
}
