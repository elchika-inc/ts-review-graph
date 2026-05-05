import type { Db } from "@elchika-inc/ts-review-graph-core";
import type { ToolResult } from "./types.js";
import { resolveFilePath } from "./resolve-path.js";

const MAX_TEST_RESULTS = 100;

const testCoverageStmtCache = new WeakMap<Db, ReturnType<Db["prepare"]>>();
function getTestCoverageStmt(db: Db) {
  let stmt = testCoverageStmtCache.get(db);
  if (!stmt) {
    stmt = db.prepare(
      `SELECT n.file
       FROM nodes impl
       JOIN edges e ON e.source_id = impl.id AND e.kind = 'HAS_TEST'
       JOIN nodes n ON n.id = e.target_id
       WHERE impl.file = ?
       LIMIT ${MAX_TEST_RESULTS + 1}`
    );
    testCoverageStmtCache.set(db, stmt);
  }
  return stmt;
}

export function getTestCoverage(
  db: Db,
  args: Record<string, unknown>
): ToolResult {
  const file = args["file"];
  if (typeof file !== "string" || file.trim() === "") {
    return {
      content: [{ type: "text", text: "file must be a non-empty string" }],
      isError: true,
    };
  }

  let resolvedFile: string;
  try {
    resolvedFile = resolveFilePath(file);
  } catch (err) {
    return {
      content: [{ type: "text", text: `無効なファイルパス: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }

  let rows: Array<{ file: string }>;
  try {
    rows = getTestCoverageStmt(db).all(resolvedFile) as typeof rows;
  } catch (err) {
    return {
      content: [{ type: "text", text: `テストカバレッジの取得に失敗しました: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }

  const safeFile = file.replace(/[\r\n]/g, "");
  const truncated = rows.length > MAX_TEST_RESULTS;
  const display = truncated ? rows.slice(0, MAX_TEST_RESULTS) : rows;
  const lines = display.map((r) => r.file.replace(/[\r\n]/g, ""));
  if (truncated) lines.push(`... (truncated at ${MAX_TEST_RESULTS} results)`);

  return {
    content: [
      {
        type: "text",
        text:
          lines.length > 0
            ? `Test files for '${safeFile}':\n${lines.join("\n")}`
            : `No test files found for '${safeFile}'`,
      },
    ],
  };
}
