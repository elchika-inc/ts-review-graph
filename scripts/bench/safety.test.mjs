import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  assertAbsoluteOutputDirectory,
  assertSafeCrgPaths,
  assertSafeDatabasePath,
  assertSafeOutputDirectory,
  validateRepositoryName,
} from "./safety.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTemporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "ts-review-graph-bench-safety-"));
  temporaryDirectories.push(directory);
  return directory;
}

test("repository name に path traversal を許可しない", () => {
  assert.throws(() => validateRepositoryName("../escape"), /repository name/);
  assert.throws(() => validateRepositoryName("__proto__"), /repository name/);
  assert.equal(validateRepositoryName("repo-1.example"), "repo-1.example");
});

test("出力先が対象 repository 内なら拒否する", () => {
  const parent = makeTemporaryDirectory();
  const repository = path.join(parent, "repository");
  mkdirSync(repository);

  assert.throws(
    () => assertSafeOutputDirectory(path.join(repository, "scratch"), [repository]),
    /repository の外側/
  );
});

test("symlink 経由で対象 repository 内へ入る出力先を拒否する", () => {
  const parent = makeTemporaryDirectory();
  const repository = path.join(parent, "repository");
  const link = path.join(parent, "linked-repository");
  mkdirSync(repository);
  symlinkSync(repository, link);

  assert.throws(
    () => assertSafeOutputDirectory(path.join(link, "scratch"), [repository]),
    /repository の外側/
  );
});

test("対象 repository 外の出力先を許可する", () => {
  const parent = makeTemporaryDirectory();
  const repository = path.join(parent, "repository");
  const output = path.join(parent, "scratch");
  mkdirSync(repository);

  assert.equal(assertSafeOutputDirectory(output, [repository]), output);
});

test("環境変数由来の相対出力先を拒否する", () => {
  assert.throws(
    () => assertAbsoluteOutputDirectory("relative/scratch", "環境変数"),
    /絶対パス/
  );
});

test("DB leaf の symlink が対象 repository 内を指す場合は拒否する", () => {
  const parent = makeTemporaryDirectory();
  const repository = path.join(parent, "repository");
  const output = path.join(parent, "scratch");
  const target = path.join(repository, "graph.db");
  mkdirSync(repository);
  mkdirSync(output);
  symlinkSync(target, path.join(output, "repo.db"));

  assert.throws(
    () => assertSafeDatabasePath(path.join(output, "repo.db"), [repository]),
    /symlink/
  );
});

test("crg home・data-dir・付随ファイルの symlink を拒否する", () => {
  const parent = makeTemporaryDirectory();
  const repository = path.join(parent, "repository");
  const output = path.join(parent, "scratch");
  mkdirSync(repository);
  mkdirSync(output);
  for (const relative of ["crg-home", "crg/repo", "crg-home/registry.json", "crg/repo/graph.db-wal"]) {
    const link = path.join(output, relative);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(repository, link);
    assert.throws(() => assertSafeCrgPaths(output, "repo", [repository]), /symlink|repository の外側/);
    rmSync(link);
  }
  assert.throws(() => assertSafeCrgPaths(repository, "repo", [repository]), /repository の外側/);
  assert.deepEqual(assertSafeCrgPaths(output, "repo", [repository]), {
    home: path.join(output, "crg-home"),
    dataDir: path.join(output, "crg", "repo"),
  });
});

test("まだ存在しない利用者 home も保護対象として扱う", () => {
  const parent = makeTemporaryDirectory();
  const home = path.join(parent, ".code-review-graph");
  assert.throws(
    () => assertSafeCrgPaths(path.join(home, "scratch"), "repo", [home]),
    /repository の外側/
  );
});
