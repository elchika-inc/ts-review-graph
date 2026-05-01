import { computeBlastRadius, DEPTH_FOR_MODE } from "@ts-review-graph/core";
import type { Db } from "@ts-review-graph/core";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function getMinimalContext(
  db: Db,
  args: Record<string, unknown>
): ToolResult {
  const changedFiles = args["changed_files"] as string[];
  const mode = (args["mode"] as "review" | "implement" | "debug") ?? "review";
  const maxDepth = DEPTH_FOR_MODE(mode);

  const allFiles = new Map<string, string>();

  for (const file of changedFiles) {
    for (const node of computeBlastRadius(db, file, maxDepth)) {
      if (!allFiles.has(node.file)) allFiles.set(node.file, node.reason);
    }
  }

  const lines = [
    `Changed: ${changedFiles.join(", ")}`,
    ``,
    `READ THESE FILES ONLY (${allFiles.size} files, mode=${mode}, depth=${maxDepth}):`,
  ];

  let i = 1;
  for (const [file, reason] of allFiles) {
    lines.push(`  ${i++}. ${file}  [${reason}]`);
  }

  const totalFiles = (
    db.prepare("SELECT COUNT(DISTINCT file) as c FROM nodes").get() as { c: number }
  ).c;
  lines.push(
    ``,
    `SKIP: ${Math.max(0, totalFiles - allFiles.size)} other files — not in blast radius`
  );

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
