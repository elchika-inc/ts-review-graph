import type { Db } from "@ts-review-graph/core";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function graphStatus(db: Db): ToolResult {
  const { nodeCount } = db
    .prepare("SELECT COUNT(*) as nodeCount FROM nodes")
    .get() as { nodeCount: number };
  const { edgeCount } = db
    .prepare("SELECT COUNT(*) as edgeCount FROM edges")
    .get() as { edgeCount: number };
  const { fileCount } = db
    .prepare("SELECT COUNT(*) as fileCount FROM file_hashes")
    .get() as { fileCount: number };
  const latest = db
    .prepare("SELECT MAX(updated_at) as t FROM file_hashes")
    .get() as { t: number | null };

  const updatedAt = latest.t
    ? new Date(latest.t).toISOString()
    : "未構築";

  return {
    content: [
      {
        type: "text",
        text: [
          `ts-review-graph status:`,
          `  nodes:      ${nodeCount}`,
          `  edges:      ${edgeCount}`,
          `  files:      ${fileCount}`,
          `  updated_at: ${updatedAt}`,
        ].join("\n"),
      },
    ],
  };
}
