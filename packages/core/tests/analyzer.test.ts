import { describe, it, expect } from "vitest";
import { analyzeProject } from "../src/analyzer.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/simple/tsconfig.json"
);
const FIXTURE_ROOT = path.dirname(FIXTURE);

const FIXTURE_WITH_TEST = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/with-test/tsconfig.json"
);
const FIXTURE_WITH_TEST_ROOT = path.dirname(FIXTURE_WITH_TEST);

describe("analyzeProject", () => {
  it("ファイルノードを抽出する", () => {
    const { nodes } = analyzeProject(FIXTURE, FIXTURE_ROOT);
    const files = nodes.filter((n) => n.kind === "file").map((n) => n.file);
    expect(files.some((f) => f.endsWith("a.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("b.ts"))).toBe(true);
  });

  it("IMPORTS_FROM エッジを生成する", () => {
    const { edges } = analyzeProject(FIXTURE, FIXTURE_ROOT);
    const importEdges = edges.filter((e) => e.kind === "IMPORTS_FROM");
    expect(importEdges.length).toBeGreaterThan(0);
    // b.ts が a.ts を import するエッジが存在する
    expect(importEdges.some((e) => e.sourceId.includes("b.ts") && e.targetId.includes("a.ts"))).toBe(true);
  });

  it("IMPLEMENTS エッジを生成する", () => {
    const { edges } = analyzeProject(FIXTURE, FIXTURE_ROOT);
    const implementsEdges = edges.filter((e) => e.kind === "IMPLEMENTS");
    expect(implementsEdges.length).toBeGreaterThan(0);
    // b.ts::Dog が a.ts::Animal を implements するエッジが存在する
    expect(implementsEdges.some(
      (e) => e.sourceId.includes("b.ts") && e.sourceId.includes("Dog") &&
             e.targetId.includes("a.ts") && e.targetId.includes("Animal")
    )).toBe(true);
  });

  it("TYPED_BY エッジを生成する（引数型参照）", () => {
    const { edges } = analyzeProject(FIXTURE, FIXTURE_ROOT);
    const typedByEdges = edges.filter((e) => e.kind === "TYPED_BY");
    expect(typedByEdges.length).toBeGreaterThan(0);
    // b.ts::introduce が a.ts::Animal に型参照するエッジが存在する（b.ts::Dog と区別して確認）
    expect(typedByEdges.some(
      (e) => e.sourceId.includes("b.ts") && e.sourceId.includes("introduce") &&
             e.targetId.includes("a.ts") && e.targetId.includes("Animal")
    )).toBe(true);
  });

  it("HAS_TEST エッジを生成する", () => {
    const { edges } = analyzeProject(FIXTURE_WITH_TEST, FIXTURE_WITH_TEST_ROOT);
    const hasTestEdges = edges.filter((e) => e.kind === "HAS_TEST");
    expect(hasTestEdges.length).toBeGreaterThan(0);
  });

  it("HAS_TEST エッジの sourceId に node_modules パスが含まれない", () => {
    const { edges } = analyzeProject(FIXTURE_WITH_TEST, FIXTURE_WITH_TEST_ROOT);
    const hasTestEdges = edges.filter((e) => e.kind === "HAS_TEST");
    for (const edge of hasTestEdges) {
      expect(edge.sourceId).not.toContain("node_modules");
      expect(edge.sourceId).toContain("impl.ts");
    }
  });
});

describe("analyzeProject のパス相対化", () => {
  it("nodes.file が projectRoot 相対になる", () => {
    const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/simple");
    const result = analyzeProject(path.join(fixtureRoot, "tsconfig.json"), fixtureRoot);
    for (const n of result.nodes) {
      expect(path.isAbsolute(n.file)).toBe(false);
      expect(n.file.startsWith("..")).toBe(false);
    }
    expect(result.nodes.some((n) => n.file === "src/a.ts")).toBe(true);
  });

  it("nodes.id も相対パスで構成される", () => {
    const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/simple");
    const result = analyzeProject(path.join(fixtureRoot, "tsconfig.json"), fixtureRoot);
    for (const n of result.nodes) {
      expect(n.id.startsWith("/")).toBe(false);
    }
    expect(result.nodes.some((n) => n.id === "src/a.ts::__file__")).toBe(true);
  });

  it("fileHashes のキーも相対パスになる", () => {
    const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/simple");
    const result = analyzeProject(path.join(fixtureRoot, "tsconfig.json"), fixtureRoot);
    for (const key of result.fileHashes.keys()) {
      expect(path.isAbsolute(key)).toBe(false);
    }
  });

  it("edges の source_id / target_id も相対パス由来になる", () => {
    const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/simple");
    const result = analyzeProject(path.join(fixtureRoot, "tsconfig.json"), fixtureRoot);
    for (const e of result.edges) {
      expect(e.sourceId.startsWith("/")).toBe(false);
      expect(e.targetId.startsWith("/")).toBe(false);
    }
  });
});
