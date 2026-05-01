import type { Db } from "@ts-review-graph/core";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function getCallers(
  db: Db,
  args: Record<string, unknown>
): ToolResult {
  const functionId = args["function_id"] as string;
  const rows = db
    .prepare(
      `SELECT n.id, n.file, n.name, n.signature
       FROM edges e
       JOIN nodes n ON n.id = e.source_id
       WHERE e.target_id = ? AND e.kind = 'CALLS'`
    )
    .all(functionId) as Array<{
    id: string;
    file: string;
    name: string;
    signature: string | null;
  }>;

  const lines = rows.map(
    (r) =>
      `${r.file}::${r.name}${r.signature ? `  ${r.signature}` : ""}`
  );
  return {
    content: [
      {
        type: "text",
        text:
          lines.length > 0
            ? `Callers of '${functionId}':\n${lines.join("\n")}`
            : `No callers found for '${functionId}'`,
      },
    ],
  };
}
