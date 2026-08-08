import { computeBlastRadius, DEPTH_FOR_MODE } from "@elchika-inc/ts-review-graph-core";
import type { Db } from "@elchika-inc/ts-review-graph-core";
import type { ToolResult } from "./types.js";
import { resolveFilePath } from "./resolve-path.js";

const MAX_RESULTS = 200;
const MAX_MERMAID_NODES = 50;

type ImpactEdge = {
  sourceFile: string;
  targetFile: string;
  kind: string;
};

function escapeMermaidLabel(value: string): string {
  return value
    .replace(/[\r\n]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/`/g, "&#96;");
}

function renderMermaid(
  db: Db,
  changedFile: string,
  nodes: ReturnType<typeof computeBlastRadius>
): string {
  const displayedFiles = [
    changedFile,
    ...nodes.slice(0, MAX_MERMAID_NODES - 1).map((node) => node.file),
  ];
  const nodeIds = new Map(displayedFiles.map((file, index) => [file, `n${index}`]));
  const placeholders = displayedFiles.map(() => "?").join(", ");
  const edges = db
    .prepare(`
      SELECT DISTINCT source.file AS sourceFile, target.file AS targetFile, e.kind
      FROM edges e
      JOIN nodes source ON source.id = e.source_id
      JOIN nodes target ON target.id = e.target_id
      WHERE source.file IN (${placeholders})
        AND target.file IN (${placeholders})
      ORDER BY source.file, target.file, e.kind
    `)
    .all(...displayedFiles, ...displayedFiles) as ImpactEdge[];

  const lines = ["```mermaid", "flowchart TD"];
  for (const [file, id] of nodeIds) {
    lines.push(`  ${id}["${escapeMermaidLabel(file)}"]`);
  }
  for (const edge of edges) {
    const sourceId = nodeIds.get(edge.sourceFile);
    const targetId = nodeIds.get(edge.targetFile);
    if (sourceId && targetId) {
      lines.push(`  ${sourceId} -->|${escapeMermaidLabel(edge.kind)}| ${targetId}`);
    }
  }
  lines.push(
    "  classDef target fill:#ffe082,stroke:#f57f17,stroke-width:3px;",
    "  class n0 target;",
    "```"
  );

  const totalNodes = nodes.length + 1;
  if (totalNodes > MAX_MERMAID_NODES) {
    lines.push(
      `... (truncated at ${MAX_MERMAID_NODES} nodes; ${totalNodes - MAX_MERMAID_NODES} omitted)`
    );
  }
  return lines.join("\n");
}

export function getImpact(db: Db, args: Record<string, unknown>): ToolResult {
  const changedFile = args["changed_file"];
  if (typeof changedFile !== "string" || changedFile.trim() === "") {
    return {
      content: [{ type: "text", text: "changed_file must be a non-empty string" }],
      isError: true,
    };
  }

  const rawFormat = args["format"];
  if (rawFormat !== undefined && rawFormat !== "text" && rawFormat !== "mermaid") {
    return {
      content: [{ type: "text", text: 'format must be one of: "text", "mermaid"' }],
      isError: true,
    };
  }
  const format = rawFormat === "mermaid" ? "mermaid" : "text";

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

  if (format === "mermaid") {
    try {
      return { content: [{ type: "text", text: renderMermaid(db, resolvedFile, nodes) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Mermaidグラフの生成に失敗しました: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

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
