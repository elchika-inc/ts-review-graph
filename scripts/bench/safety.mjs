import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

const RESERVED_REPOSITORY_NAMES = new Set([
  ".",
  "..",
  "__proto__",
  "constructor",
  "prototype",
]);

export function validateRepositoryName(name) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
    || RESERVED_REPOSITORY_NAMES.has(name)
  ) {
    throw new Error(`repository name が不正です: ${name}`);
  }
  return name;
}

export function assertAbsoluteOutputDirectory(value, source) {
  if (!path.isAbsolute(value)) {
    throw new Error(`${source}の出力先は絶対パスで指定してください`);
  }
  return path.resolve(value);
}

function resolveThroughExistingAncestor(candidate) {
  let current = path.resolve(candidate);
  const missingSegments = [];

  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`出力先を解決できません: ${candidate}`);
    }
    missingSegments.unshift(path.basename(current));
    current = parent;
  }

  return path.join(realpathSync(current), ...missingSegments);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export function assertSafeOutputDirectory(outDir, repositoryRoots) {
  const resolvedOutDir = path.resolve(outDir);
  const physicalOutDir = resolveThroughExistingAncestor(resolvedOutDir);

  for (const repositoryRoot of repositoryRoots) {
    const physicalRepositoryRoot = realpathSync(repositoryRoot);
    if (isInside(physicalRepositoryRoot, physicalOutDir)) {
      throw new Error(
        `scratch DB の出力先は対象 repository の外側に指定してください: ${resolvedOutDir}`
      );
    }
  }

  return resolvedOutDir;
}

export function assertSafeDatabasePath(dbPath, repositoryRoots) {
  const resolvedDbPath = path.resolve(dbPath);
  const sqlitePaths = [
    resolvedDbPath,
    `${resolvedDbPath}-wal`,
    `${resolvedDbPath}-shm`,
    `${resolvedDbPath}-journal`,
  ];

  for (const sqlitePath of sqlitePaths) {
    try {
      if (lstatSync(sqlitePath).isSymbolicLink()) {
        throw new Error(`scratch DB の path に symlink は指定できません: ${sqlitePath}`);
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    const physicalPath = resolveThroughExistingAncestor(sqlitePath);
    for (const repositoryRoot of repositoryRoots) {
      const physicalRepositoryRoot = realpathSync(repositoryRoot);
      if (isInside(physicalRepositoryRoot, physicalPath)) {
        throw new Error(
          `scratch DB は対象 repository の外側に指定してください: ${sqlitePath}`
        );
      }
    }
  }

  return resolvedDbPath;
}
