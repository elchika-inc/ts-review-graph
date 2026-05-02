import type { Db } from "@ts-review-graph/core";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

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

  const escaped = typeName.replace(/%/g, "\\%").replace(/_/g, "\\_");
  const rows = db
    .prepare(
      `SELECT DISTINCT n.file, n.name, n.kind
       FROM nodes n
       WHERE n.type_refs LIKE ? ESCAPE '\\'
       ORDER BY n.file`
    )
    .all(`%${escaped}%`) as Array<{
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
