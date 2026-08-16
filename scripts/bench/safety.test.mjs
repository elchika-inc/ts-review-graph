import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  assertAbsoluteOutputDirectory,
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
