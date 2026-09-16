import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
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
    const physicalRepositoryRoot = resolveThroughExistingAncestor(repositoryRoot);
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
      const physicalRepositoryRoot = resolveThroughExistingAncestor(repositoryRoot);
      if (isInside(physicalRepositoryRoot, physicalPath)) {
        throw new Error(
          `scratch DB は対象 repository の外側に指定してください: ${sqlitePath}`
        );
      }
    }
  }

  return resolvedDbPath;
}

// crg は SQLite 以外に registry や補助ファイルも書くため、既存の子孫も検査する。
function assertNoSymlinks(candidate) {
  const stat = lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new Error(`crg の出力先に symlink は指定できません: ${candidate}`);
  }
  if (stat.isDirectory()) {
    for (const name of readdirSync(candidate)) assertNoSymlinks(path.join(candidate, name));
  }
}

export function assertSafeCrgPaths(outDir, name, repositoryRoots) {
  validateRepositoryName(name);
  const home = path.join(outDir, "crg-home");
  const dataRoot = path.join(outDir, "crg");
  const dataDir = path.join(dataRoot, name);
  for (const candidate of [outDir, home, dataRoot, dataDir]) {
    assertSafeOutputDirectory(candidate, repositoryRoots);
    if (lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`crg の出力先に symlink は指定できません: ${candidate}`);
    }
  }
  assertNoSymlinks(home);
  assertNoSymlinks(dataDir);
  assertSafeDatabasePath(path.join(dataDir, "graph.db"), repositoryRoots);
  return { home, dataDir };
}
