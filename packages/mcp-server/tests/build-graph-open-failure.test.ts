import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// 破損 DB を再現するため openDb だけ差し替える。
// ヘルパ単体のテストでは「build_graph がそのヘルパを使っているか」を検証できない。
vi.mock("@elchika-inc/ts-review-graph-core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openDb: () => {
    throw new Error("file is not a database");
  },
}));

const { buildGraph } = await import("../src/tools/build-graph.js");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  delete process.env["TS_REVIEW_GRAPH_DB"];
});

describe("build_graph の DB オープン失敗（配線）", () => {
  it("破損した DB では dbPath と削除手順を返す", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ts-rg-build-open-"));
    roots.push(root);
    writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["src"] }));

    const dbPath = path.join(root, "graph.db");
    writeFileSync(dbPath, "not a database\n");
    process.env["TS_REVIEW_GRAPH_DB"] = dbPath;

    const result = buildGraph({ tsconfigs: [path.join(root, "tsconfig.json")] });
    const text = result.content[0]?.text ?? "";

    expect(result.isError).toBe(true);
    expect(text.split("\n")[0]).toContain(dbPath);
    expect(text).toContain("rm -f --");
    expect(text).toContain("graph.db-wal");
  });
});
