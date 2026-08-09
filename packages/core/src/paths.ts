import path from "node:path";

// DB に保存するパスはプロジェクトルート相対の POSIX パスに統一する。
// これにより graph.db はリポジトリの位置に依存しなくなる（worktree・リポ移動・別マシンで再利用可能）。
export function toProjectRelative(projectRoot: string, filePath: string): string {
  if (!path.isAbsolute(filePath)) {
    return filePath.split(path.sep).join("/");
  }
  const normalizedRoot = path.resolve(projectRoot);
  const rel = path.relative(normalizedRoot, path.resolve(filePath));
  // path.relative はルート外を指すとき ".." で始まる
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path is outside project root: ${filePath}`);
  }
  return rel.split(path.sep).join("/");
}

export function toProjectAbsolute(projectRoot: string, relPath: string): string {
  if (path.isAbsolute(relPath)) return relPath;
  return path.resolve(projectRoot, relPath);
}
