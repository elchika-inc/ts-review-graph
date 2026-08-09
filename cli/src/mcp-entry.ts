import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
const cliVersion = (JSON.parse(readFileSync(packagePath, "utf-8")) as { version: string }).version;

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// .mcp.json は git 管理下に置かれるため、絶対パスを書き込むと
// リポジトリの移動・別マシンでのクローンで壊れる（実障害あり）。
// 既定パスならサーバー側の既定値 process.cwd()/.ts-review-graph/graph.db に委ねる。
// CLI・core・MCP server は常に同一バージョンで公開する運用を前提とし、
// 読み手だけが古くなる組み合わせを防ぐため MCP server を CLI の version へ固定する。
export function buildMcpServerEntry(projectRoot: string, dbPath: string): McpServerEntry {
  const entry: McpServerEntry = {
    command: "npx",
    args: ["-y", `@elchika-inc/ts-review-graph-mcp-server@${cliVersion}`],
  };
  const defaultDb = path.join(projectRoot, ".ts-review-graph/graph.db");
  if (path.resolve(dbPath) !== path.resolve(defaultDb)) {
    entry.env = {
      TS_REVIEW_GRAPH_DB: path.relative(projectRoot, dbPath).split(path.sep).join("/"),
    };
  }
  return entry;
}
