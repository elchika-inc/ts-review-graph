import path from "node:path";
import { realpathSync } from "node:fs";

// 相対/絶対パスをプロジェクトルート基準の絶対パスに変換する
// DB_PATH = <root>/.ts-review-graph/graph.db なので dirname の親がルート
// パストラバーサル（../../）や絶対パス指定によるプロジェクト外アクセスを防ぐ
// シンボリックリンクバイパス対策: ファイルが存在する場合は realpathSync で検証する
export function resolveFilePath(file: string): string {
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
    // ENOENT: ファイルが存在しない場合はシンボリックリンクバイパス不可 — 許容
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") return resolved;
    // EACCES / ELOOP 等: シンボリックリンク検証が不可 — fail-closed
    const code = (e as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(`Path safety check failed (${code}): ${file}`);
  }

  return resolved;
}
