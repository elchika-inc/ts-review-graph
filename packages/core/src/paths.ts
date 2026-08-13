import path from "node:path";
import { realpathSync } from "node:fs";

function isOutsideRoot(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  );
}

function realpathWithMissingTail(absolutePath: string): string {
  const missingParts: string[] = [];
  let candidate = absolutePath;

  while (true) {
    try {
      return path.join(realpathSync(candidate), ...missingParts);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missingParts.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

// DB に保存するパスはプロジェクトルート相対の POSIX パスに統一する。
// これにより graph.db はリポジトリの位置に依存しなくなる（worktree・リポ移動・別マシンで再利用可能）。
export function toProjectRelative(projectRoot: string, filePath: string): string {
  const normalizedRoot = path.resolve(projectRoot);
  const absolutePath = path.resolve(normalizedRoot, filePath);
  const rel = path.relative(normalizedRoot, absolutePath);
  // path.relative はルート外を指すとき ".." そのもの、または "../" で始まる。
  // "..foo.ts" のように合法なファイル名まで拒否しないよう、区切り文字まで比較する。
  if (!isOutsideRoot(rel)) {
    return rel.split(path.sep).join("/");
  }

  // 通常経路でルート外になったときだけ、symlink を解決して同じ実体か再判定する。
  // 対象が未作成でも、存在する最も近い祖先を解決して末尾を復元する。
  try {
    const physicalRoot = realpathSync(normalizedRoot);
    const physicalPath = realpathWithMissingTail(absolutePath);
    const physicalRel = path.relative(physicalRoot, physicalPath);
    if (!isOutsideRoot(physicalRel)) {
      return physicalRel.split(path.sep).join("/");
    }
  } catch {
    // ENOENT で祖先まで解決できない場合や EACCES / ELOOP は fail-closed にする。
  }

  throw new Error(`Path is outside project root: ${filePath}`);
}

export function toProjectAbsolute(projectRoot: string, relPath: string): string {
  if (path.isAbsolute(relPath)) return relPath;
  return path.resolve(projectRoot, relPath);
}
