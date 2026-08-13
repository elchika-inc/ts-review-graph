// ABI 診断の実装は core が正本 — MCP サーバーの degraded mode でも同じ文言を使う。
// CLI からの参照経路を保つため、ここで再エクスポートする。
export { formatNpxAbiMismatchGuidance } from "@elchika-inc/ts-review-graph-core";

export interface GitignoreUpdate {
  content: string;
  changed: boolean;
}

const gitignoreHeader = "# ts-review-graph (graph.db はビルド成果物、config.json はコミット対象)";
const graphIgnoreLines = [
  ".ts-review-graph/graph.db",
  ".ts-review-graph/graph.db-wal",
  ".ts-review-graph/graph.db-shm",
] as const;
const graphIgnoreBlock = `${gitignoreHeader}\n${graphIgnoreLines.join("\n")}\n`;

export function updateGraphGitignore(content: string): GitignoreUpdate {
  const lines = content.split(/\r?\n/);
  const complete =
    lines.filter((line) => line === gitignoreHeader).length === 1 &&
    graphIgnoreLines.every(
      (target) => lines.filter((line) => line === target).length === 1
    ) &&
    !lines.includes(".ts-review-graph/") &&
    !lines.includes(".ts-review-graph/graph.db*");

  if (complete) {
    return { content, changed: false };
  }

  const obsoleteLines = new Set<string>([
    "# ts-review-graph",
    gitignoreHeader,
    ".ts-review-graph/",
    ".ts-review-graph/graph.db*",
    ...graphIgnoreLines,
  ]);
  const retained = lines.filter((line) => !obsoleteLines.has(line));
  while (retained.at(-1) === "") retained.pop();

  const prefix = retained.length > 0 ? `${retained.join("\n")}\n\n` : "";
  return {
    content: `${prefix}${graphIgnoreBlock}`,
    changed: true,
  };
}

