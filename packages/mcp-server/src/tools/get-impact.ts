import { computeBlastRadius, DEPTH_FOR_MODE } from "@ts-review-graph/core";
import type { Db } from "@ts-review-graph/core";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const MAX_RESULTS = 200;

export function getImpact(db: Db, args: Record<string, unknown>): ToolResult {
  const changedFile = args["changed_file"];
  if (typeof changedFile !== "string" || changedFile.trim() === "") {
    return {
      content: [{ type: "text", text: "changed_file must be a non-empty string" }],
      isError: true,
    };
  }

  const nodes = computeBlastRadius(db, changedFile, DEPTH_FOR_MODE("debug"));

  const truncated = nodes.slice(0, MAX_RESULTS);
  const suffix =
    nodes.length > MAX_RESULTS
      ? `\n... and ${nodes.length - MAX_RESULTS} more (truncated at ${MAX_RESULTS})`
      : "";
  const lines = truncated.map((n) => `${n.file}  [${n.reason}, depth=${n.depth}]`);

  return {
    content: [
      {
        type: "text",
        text:
          lines.length > 0
            ? `Impact of ${changedFile}:\n${lines.join("\n")}${suffix}`
            : `No dependents found for ${changedFile}`,
      },
    ],
  };
}
