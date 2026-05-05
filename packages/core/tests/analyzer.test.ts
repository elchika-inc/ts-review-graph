import { describe, it, expect } from "vitest";
import { analyzeProject } from "../src/analyzer.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/simple/tsconfig.json"
);

const FIXTURE_WITH_TEST = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/with-test/tsconfig.json"
);

describe("analyzeProject", () => {
  it("ファイルノードを抽出する", () => {
    const { nodes } = analyzeProject(FIXTURE);
    const files = nodes.filter((n) => n.kind === "file").map((n) => n.file);
    expect(files.some((f) => f.endsWith("a.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("b.ts"))).toBe(true);
  });

  it("IMPORTS_FROM エッジを生成する", () => {
    const { edges } = analyzeProject(FIXTURE);
    const importEdges = edges.filter((e) => e.kind === "IMPORTS_FROM");
    expect(importEdges.length).toBeGreaterThan(0);
  });

  it("IMPLEMENTS エッジを生成する", () => {
    const { edges } = analyzeProject(FIXTURE);
    const implementsEdges = edges.filter((e) => e.kind === "IMPLEMENTS");
    expect(implementsEdges.length).toBeGreaterThan(0);
  });

  it("TYPED_BY エッジを生成する（引数型参照）", () => {
    const { edges } = analyzeProject(FIXTURE);
    const typedByEdges = edges.filter((e) => e.kind === "TYPED_BY");
    expect(typedByEdges.length).toBeGreaterThan(0);
  });

  it("HAS_TEST エッジを生成する", () => {
    const { edges } = analyzeProject(FIXTURE_WITH_TEST);
    const hasTestEdges = edges.filter((e) => e.kind === "HAS_TEST");
    expect(hasTestEdges.length).toBeGreaterThan(0);
  });

  it("HAS_TEST エッジの sourceId に node_modules パスが含まれない", () => {
    const { edges } = analyzeProject(FIXTURE_WITH_TEST);
    const hasTestEdges = edges.filter((e) => e.kind === "HAS_TEST");
    for (const edge of hasTestEdges) {
      expect(edge.sourceId).not.toContain("node_modules");
      expect(edge.sourceId).toContain("impl.ts");
    }
  });
});
