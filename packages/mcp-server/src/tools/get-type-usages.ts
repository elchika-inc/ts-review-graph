import type { Db } from "@ts-review-graph/core";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function getTypeUsages(
  db: Db,
  args: Record<string, unknown>
): ToolResult {
  const typeName = args["type_name"] as string;
  const rows = db
    .prepare(
      `SELECT DISTINCT n.file, n.name, n.kind
       FROM nodes n
       WHERE n.type_refs LIKE ?
       ORDER BY n.file`
    )
    .all(`%${typeName}%`) as Array<{
    file: string;
    name: string;
    kind: string;
  }>;

  const lines = rows.map((r) => `${r.file}::${r.name}  [${r.kind}]`);
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
