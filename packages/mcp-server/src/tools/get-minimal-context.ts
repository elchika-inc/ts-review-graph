import { computeBlastRadius, computeForwardDeps, DEPTH_FOR_MODE } from "@ts-review-graph/core";
import type { Db } from "@ts-review-graph/core";
import path from "node:path";
import type { ToolResult } from "./types.js";

const VALID_MODES = ["review", "implement", "debug"] as const;
type Mode = typeof VALID_MODES[number];

function validateArgs(args: Record<string, unknown>): { files: string[]; mode: Mode } {
  const files = args["changed_files"];
  if (!Array.isArray(files) || files.length === 0 || !files.every((f) => typeof f === "string")) {
    throw new Error("changed_files must be a non-empty array of strings");
  }
  const mode = (args["mode"] ?? "review") as string;
  if (!VALID_MODES.includes(mode as Mode)) {
    throw new Error(`mode must be one of: ${VALID_MODES.join(", ")}`);
  }
  return { files: files as string[], mode: mode as Mode };
}

// 相対/絶対パスをプロジェクトルート基準の絶対パスに変換する
// DB_PATH = <root>/.ts-review-graph/graph.db なので dirname の親がルート
// パストラバーサル（../../）や絶対パス指定によるプロジェクト外アクセスを防ぐ
function resolveFilePath(file: string): string {
  const dbPath = process.env["TS_REVIEW_GRAPH_DB"];
  // TS_REVIEW_GRAPH_DB 未設定時は process.cwd() をプロジェクトルートとして使用
  const projectRoot = dbPath
    ? path.resolve(path.dirname(dbPath), "..")
    : process.cwd();

  const resolved = path.isAbsolute(file)
    ? path.normalize(file)
    : path.resolve(projectRoot, file);

  if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
    throw new Error(`Path traversal detected: ${file}`);
  }
  return resolved;
}

export function getMinimalContext(
  db: Db,
  args: Record<string, unknown>
): ToolResult {
  const { files: rawFiles, mode } = validateArgs(args);
  const changedFiles = rawFiles.map(resolveFilePath);
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
    `Changed: ${rawFiles.join(", ")}`,
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
