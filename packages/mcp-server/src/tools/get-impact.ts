import { computeBlastRadius, DEPTH_FOR_MODE } from "@ts-review-graph/core";
import type { Db } from "@ts-review-graph/core";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function getImpact(db: Db, args: Record<string, unknown>): ToolResult {
  const changedFile = args["changed_file"] as string;
  const nodes = computeBlastRadius(db, changedFile, DEPTH_FOR_MODE("debug"));

  const lines = nodes.map(
    (n) => `${n.file}  [${n.reason}, depth=${n.depth}]`
  );

  return {
    content: [
      {
        type: "text",
        text:
          lines.length > 0
            ? `Impact of ${changedFile}:\n${lines.join("\n")}`
            : `No dependents found for ${changedFile}`,
      },
    ],
  };
}
