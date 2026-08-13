import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ABI_ERROR =
  "The module '/Users/test/.npm/_npx/08af52269914770e/node_modules/better_sqlite3.node' " +
  "was compiled against a different Node.js version using NODE_MODULE_VERSION 137";

// 本物の better-sqlite3 では ABI 不一致を再現できないため openDb だけ差し替える。
// vi.mock はファイル単位で巻き上がるので、他のテストへ影響しないよう独立ファイルに置く。
vi.mock("@elchika-inc/ts-review-graph-core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openDb: () => {
    throw new Error(ABI_ERROR);
  },
}));

const { buildGraph } = await import("../src/tools/build-graph.js");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createProject(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "ts-rg-abi-build-"));
  roots.push(root);
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["src"] }));
  return root;
}

describe("build_graph の ABI 診断", () => {
  it("openDb が ABI 不一致で失敗したら npx キャッシュ削除の手順を返す", () => {
    const root = createProject();

    const result = buildGraph({ tsconfigs: [path.join(root, "tsconfig.json")] });

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("データベースを開けませんでした");
    expect(text).toContain("ネイティブモジュールの Node ABI が一致していません。");
    expect(text).toContain("rm -rf -- '/Users/test/.npm/_npx/08af52269914770e'");
  });
});
