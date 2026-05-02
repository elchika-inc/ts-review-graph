import { computeBlastRadius, computeForwardDeps, DEPTH_FOR_MODE } from "@ts-review-graph/core";
import type { Db } from "@ts-review-graph/core";
import path from "node:path";
import { realpathSync } from "node:fs";
import type { ToolResult } from "./types.js";

const VALID_MODES = ["review", "implement", "debug"] as const;

// COUNT クエリのステートメントを Db インスタンスごとにキャッシュ — ホットパスで prepare を繰り返さない
// better-sqlite3 の型定義では get() の引数制約が曖昧なため、明示的に { get(): unknown } インタフェースを使用
interface NoParamStmt { get(): unknown }
const countStmtCache = new WeakMap<Db, NoParamStmt>();
function getCountStmt(db: Db): NoParamStmt {
  let stmt = countStmtCache.get(db);
  if (!stmt) {
    stmt = db.prepare("SELECT COUNT(DISTINCT file) as c FROM nodes") as unknown as NoParamStmt;
    countStmtCache.set(db, stmt);
  }
  return stmt;
}
type Mode = typeof VALID_MODES[number];

const MAX_CHANGED_FILES = 100;

type ValidatedArgs = { files: string[]; mode: Mode };

function validateArgs(args: Record<string, unknown>): ValidatedArgs | ToolResult {
  const files = args["changed_files"];
  if (!Array.isArray(files) || files.length === 0 || !files.every((f) => typeof f === "string")) {
    return {
      content: [{ type: "text", text: "changed_files must be a non-empty array of strings" }],
      isError: true,
    };
  }
  if (files.length > MAX_CHANGED_FILES) {
    return {
      content: [{ type: "text", text: `changed_files must have at most ${MAX_CHANGED_FILES} entries (got ${files.length})` }],
      isError: true,
    };
  }
  const rawMode = args["mode"] ?? "review";
  if (typeof rawMode !== "string") {
    return {
      content: [{ type: "text", text: `mode must be one of: ${VALID_MODES.join(", ")}` }],
      isError: true,
    };
  }
  if (!VALID_MODES.includes(rawMode as Mode)) {
    return {
      content: [{ type: "text", text: `mode must be one of: ${VALID_MODES.join(", ")}` }],
      isError: true,
    };
  }
  return { files: files as string[], mode: rawMode as Mode };
}

// 相対/絶対パスをプロジェクトルート基準の絶対パスに変換する
// DB_PATH = <root>/.ts-review-graph/graph.db なので dirname の親がルート
// パストラバーサル（../../）や絶対パス指定によるプロジェクト外アクセスを防ぐ
// シンボリックリンクバイパス対策: ファイルが存在する場合は realpathSync で検証する
function resolveFilePath(file: string): string {
  const dbPath = process.env["TS_REVIEW_GRAPH_DB"];
  // TS_REVIEW_GRAPH_DB 未設定時は process.cwd() をプロジェクトルートとして使用
  const projectRoot = dbPath
    ? path.resolve(path.dirname(dbPath), "..")
    : process.cwd();

  const resolved = path.isAbsolute(file)
    ? path.normalize(file)
    : path.resolve(projectRoot, file);

  // 第1チェック: 正規化パスによるトラバーサル検出
  if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
    throw new Error(`Path traversal detected: ${file}`);
  }

  // 第2チェック: ファイルが存在する場合のシンボリックリンクバイパス検出
  // (存在しないファイルはシンボリックリンクにはなれない)
  try {
    const realResolved = realpathSync(resolved);
    const realProjectRoot = realpathSync(projectRoot);
    if (!realResolved.startsWith(realProjectRoot + path.sep) && realResolved !== realProjectRoot) {
      throw new Error(`Path traversal detected: ${file}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Path traversal")) throw e;
    // ENOENT など — ファイルが存在しない場合はシンボリックリンクバイパス不可
  }

  return resolved;
}

export function getMinimalContext(
  db: Db,
  args: Record<string, unknown>
): ToolResult {
  const validated = validateArgs(args);
  if ("content" in validated) return validated;

  const { files: rawFiles, mode } = validated;
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

  const totalFiles = (getCountStmt(db).get() as { c: number }).c;

  const lines: string[] = [
    `Changed: ${rawFiles.join(", ")}`,
    ``,
  ];

  // implement モードでは変更ファイル自身はリストから除外して表示
  // shownCount はあくまで表示したファイル数（変更ファイル自身を除く）
  if (mode === "implement") {
    const displayedReverse: string[] = [];
    for (const [file, reason] of reverseFiles) {
      if (changedFiles.includes(file)) continue;
      displayedReverse.push(`  ${displayedReverse.length + 1}. ${file}  [${reason}]`);
    }

    lines.push(`── 影響を受けるファイル（REVERSE depth=${maxDepth}） ──`);
    if (displayedReverse.length === 0) {
      lines.push(`  (なし)`);
    } else {
      lines.push(...displayedReverse);
    }

    lines.push(``, `── 一緒に変えるべきファイル（FORWARD depth=1） ──`);
    if (forwardFiles.size === 0) {
      lines.push(`  (なし — 他パッケージへの直接依存なし)`);
    } else {
      let i = 1;
      for (const [file, reason] of forwardFiles) {
        lines.push(`  ${i++}. ${file}  [${reason}]`);
      }
    }

    const shownCount = reverseFiles.size + forwardFiles.size;
    lines.push(``, `SKIP: ${Math.max(0, totalFiles - shownCount)} other files — not in blast radius`);
  } else {
    lines.push(`READ THESE FILES ONLY (${reverseFiles.size} files, mode=${mode}, depth=${maxDepth}):`);
    let i = 1;
    for (const [file, reason] of reverseFiles) {
      lines.push(`  ${i++}. ${file}  [${reason}]`);
    }
    lines.push(``, `SKIP: ${Math.max(0, totalFiles - reverseFiles.size)} other files — not in blast radius`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
