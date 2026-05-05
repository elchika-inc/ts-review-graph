import { computeBlastRadius, DEPTH_FOR_MODE } from "@elchika-inc/ts-review-graph-core";
import type { Db } from "@elchika-inc/ts-review-graph-core";
import type { ToolResult } from "./types.js";
import { resolveFilePath } from "./resolve-path.js";

const MAX_RESULTS = 200;

export function getImpact(db: Db, args: Record<string, unknown>): ToolResult {
  const changedFile = args["changed_file"];
  if (typeof changedFile !== "string" || changedFile.trim() === "") {
    return {
      content: [{ type: "text", text: "changed_file must be a non-empty string" }],
      isError: true,
    };
  }

  let resolvedFile: string;
  try {
    resolvedFile = resolveFilePath(changedFile);
  } catch (err) {
    return {
      content: [{ type: "text", text: `無効なファイルパス: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }

  let nodes: ReturnType<typeof computeBlastRadius>;
  try {
    nodes = computeBlastRadius(db, resolvedFile, DEPTH_FOR_MODE("debug"));
  } catch (err) {
    return {
      content: [{ type: "text", text: `依存関係の解析に失敗しました: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
  nodes = nodes.filter((n) => n.file !== resolvedFile);

  const sanitize = (s: string) => s.replace(/[\r\n]/g, "");
  const safeChangedFile = sanitize(changedFile);
  const display = nodes.slice(0, MAX_RESULTS);
  const suffix =
    nodes.length > MAX_RESULTS
      ? `\n... and ${nodes.length - MAX_RESULTS} more (truncated at ${MAX_RESULTS})`
      : "";
  const lines = display.map((n) => `${sanitize(n.file)}  [${sanitize(n.reason)}, depth=${n.depth}]`);

  return {
    content: [
      {
        type: "text",
        text:
          lines.length > 0
            ? `Impact of ${safeChangedFile}:\n${lines.join("\n")}${suffix}`
            : `No dependents found for ${safeChangedFile}`,
      },
    ],
  };
}
