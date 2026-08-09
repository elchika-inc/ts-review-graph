import path from "node:path";
import { realpathSync } from "node:fs";
import { toProjectRelative } from "@elchika-inc/ts-review-graph-core";

// 相対/絶対パスをプロジェクトルート相対のパスに変換する
// パストラバーサル（../../）や絶対パス指定によるプロジェクト外アクセスを防ぐ
// シンボリックリンクバイパス対策: ファイルが存在する場合は realpathSync で検証する
export function resolveFilePath(file: string): string {
  // ファイルパスに改行文字が含まれることはあり得ない — 早期拒否で下流処理を保護する
  if (/[\r\n]/.test(file)) {
    throw new Error(`Path traversal detected: ${file}`);
  }

  // DB の保存場所は --db で独立に変更できるため、起動 cwd をプロジェクトルートとする。
  const projectRoot = path.resolve(process.cwd());

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
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
      return toProjectRelative(projectRoot, resolved);
    }
    // EACCES / ELOOP 等: シンボリックリンク検証が不可 — fail-closed
    const code = (e as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(`Path safety check failed (${code}): ${file}`);
  }

  return toProjectRelative(projectRoot, resolved);
}
