import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, buildFullGraph, computeBlastRadius } from "@elchika-inc/ts-review-graph-core";
import { cpSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

let rootA: string;
let rootB: string;

function makeProject(dir: string): void {
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, ".ts-review-graph"), { recursive: true });
  writeFileSync(path.join(dir, "src/dep.ts"), "export const dep = 1;\n");
  writeFileSync(path.join(dir, "src/main.ts"), "import { dep } from './dep.js';\nexport const main = dep;\n");
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" }, include: ["src"] })
  );
  writeFileSync(
    path.join(dir, ".ts-review-graph/config.json"),
    JSON.stringify({ tsconfigs: ["tsconfig.json"] })
  );
}

beforeEach(() => {
  rootA = path.join(os.tmpdir(), `ts-rg-portA-${randomUUID()}`);
  rootB = path.join(os.tmpdir(), `ts-rg-portB-${randomUUID()}`);
  makeProject(rootA);
});

afterEach(() => {
  for (const d of [rootA, rootB]) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe("グラフの可搬性（リポジトリ移動シミュレーション）", () => {
  it("プロジェクトごと別ディレクトリへコピーしても同じ結果を返す", () => {
    const dbPathA = path.join(rootA, ".ts-review-graph/graph.db");
    const dbA = openDb(dbPathA);
    buildFullGraph(dbA, [path.join(rootA, "tsconfig.json")], rootA);
    const before = computeBlastRadius(dbA, "src/dep.ts", 2).map((n) => n.file).sort();
    dbA.close();

    // 変更前の値をベースラインとして取る（0 件だと「一致」が無意味になるため下限を確認）
    expect(before).toContain("src/main.ts");

    // プロジェクトを丸ごと別の場所へコピーする（graph.db ごと）
    cpSync(rootA, rootB, { recursive: true });

    const dbB = openDb(path.join(rootB, ".ts-review-graph/graph.db"));
    const after = computeBlastRadius(dbB, "src/dep.ts", 2).map((n) => n.file).sort();
    dbB.close();

    expect(after).toEqual(before);
  });
});
