import type { Db } from "@ts-review-graph/core";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function getTestCoverage(
  db: Db,
  args: Record<string, unknown>
): ToolResult {
  const file = args["file"] as string;
  const rows = db
    .prepare(
      `SELECT n.file
       FROM nodes impl
       JOIN edges e ON e.source_id = impl.id AND e.kind = 'HAS_TEST'
       JOIN nodes n ON n.id = e.target_id
       WHERE impl.file = ?`
    )
    .all(file) as Array<{ file: string }>;

  const lines = rows.map((r) => r.file);
  return {
    content: [
      {
        type: "text",
        text:
          lines.length > 0
            ? `Test files for '${file}':\n${lines.join("\n")}`
            : `No test files found for '${file}'`,
      },
    ],
  };
}
