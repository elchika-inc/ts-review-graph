import { computeBlastRadius, computeForwardDeps, DEPTH_FOR_MODE } from "@ts-review-graph/core";
import type { Db } from "@ts-review-graph/core";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function getMinimalContext(
  db: Db,
  args: Record<string, unknown>
): ToolResult {
  const changedFiles = args["changed_files"] as string[];
  const mode = (args["mode"] as "review" | "implement" | "debug") ?? "review";
  const maxDepth = DEPTH_FOR_MODE(mode);

  const reverseFiles = new Map<string, string>();
  const forwardFiles = new Map<string, string>();

  for (const file of changedFiles) {
    for (const node of computeBlastRadius(db, file, maxDepth)) {
      if (!reverseFiles.has(node.file)) reverseFiles.set(node.file, node.reason);
    }

    if (mode === "implement") {
      for (const node of computeForwardDeps(db, file)) {
        if (!reverseFiles.has(node.file) && !forwardFiles.has(node.file)) {
          forwardFiles.set(node.file, node.reason);
        }
      }
    }
  }

  const totalFiles = (
    db.prepare("SELECT COUNT(DISTINCT file) as c FROM nodes").get() as { c: number }
  ).c;

  const lines: string[] = [
    `Changed: ${changedFiles.join(", ")}`,
    ``,
  ];

  if (mode === "implement") {
    lines.push(`── 影響を受けるファイル（REVERSE depth=${maxDepth}） ──`);
    let reverseCount = 0;
    for (const [file, reason] of reverseFiles) {
      if (changedFiles.includes(file)) continue;
      lines.push(`  ${++reverseCount}. ${file}  [${reason}]`);
    }
    if (reverseCount === 0) lines.push(`  (なし)`);

    lines.push(``, `── 一緒に変えるべきファイル（FORWARD depth=1） ──`);
    if (forwardFiles.size === 0) {
      lines.push(`  (なし — 他パッケージへの直接依存なし)`);
    } else {
      let i = 1;
      for (const [file, reason] of forwardFiles) {
        lines.push(`  ${i++}. ${file}  [${reason}]`);
      }
    }
  } else {
    lines.push(`READ THESE FILES ONLY (${reverseFiles.size} files, mode=${mode}, depth=${maxDepth}):`);
    let i = 1;
    for (const [file, reason] of reverseFiles) {
      lines.push(`  ${i++}. ${file}  [${reason}]`);
    }
  }

  const shownCount = reverseFiles.size + forwardFiles.size;
  lines.push(
    ``,
    `SKIP: ${Math.max(0, totalFiles - shownCount)} other files — not in blast radius`
  );

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
