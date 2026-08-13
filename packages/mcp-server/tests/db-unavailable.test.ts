import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatNpxAbiMismatchGuidance } from "@elchika-inc/ts-review-graph-core";
import {
  formatDbOpenFailureLines,
  formatDbUnavailableText,
  withAbiGuidance,
  GRAPH_NOT_BUILT_TEXT,
} from "../src/tools/db-unavailable.js";
import { registerTools } from "../src/tools/index.js";
import { graphStatus } from "../src/tools/graph-status.js";
import { buildGraph } from "../src/tools/build-graph.js";

const ABI_ERROR = `The module '/Users/test/.npm/_npx/08af52269914770e/node_modules/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 137`;

describe("MCP サーバーの ABI 診断参照", () => {
  it("core の共通実装を MCP 側からも参照できる", () => {
    expect(typeof formatNpxAbiMismatchGuidance).toBe("function");
    expect(formatNpxAbiMismatchGuidance(ABI_ERROR)).toEqual([
      "ネイティブモジュールの Node ABI が一致していません。",
      "次の npx キャッシュを削除してから、同じコマンドを再実行してください:",
      "rm -rf -- '/Users/test/.npm/_npx/08af52269914770e'",
    ]);
  });

  it("degraded mode の説明に core の復旧手順を埋め込む", () => {
    const lines = formatDbOpenFailureLines({ dbPath: "/repo/.ts-review-graph/graph.db", message: ABI_ERROR });
    expect(lines).toContain("  rm -rf -- '/Users/test/.npm/_npx/08af52269914770e'");
  });

  it("ABI 診断の合成は共通ヘルパが担う（全 DB オープン経路で同じ出力）", () => {
    expect(withAbiGuidance("データベースを開けませんでした — " + ABI_ERROR, ABI_ERROR)).toContain(
      "  rm -rf -- '/Users/test/.npm/_npx/08af52269914770e'"
    );
  });

  it("ABI 不一致でないエラーには余計な手順を足さない", () => {
    expect(withAbiGuidance("データベースを開けませんでした — x", "file is not a database")).toBe(
      "データベースを開けませんでした — x"
    );
  });

  it("degraded が案内する復旧経路 build_graph も失敗理由を返す", () => {
    // degraded メッセージは build_graph へ誘導する。その build_graph が理由を返さないと
    // 利用者は復旧手順に辿り着けないまま行き止まりになる。
    const root = mkdtempSync(path.join(os.tmpdir(), "ts-rg-buildgraph-"));
    const previous = process.env["TS_REVIEW_GRAPH_DB"];
    try {
      writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["src"] }));
      writeFileSync(path.join(root, "graph.db"), "not a database\n");
      process.env["TS_REVIEW_GRAPH_DB"] = path.join(root, "graph.db");

      const result = buildGraph({ tsconfigs: [path.join(root, "tsconfig.json")] });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("データベースを開けませんでした");
      expect(result.content[0]?.text).toContain("file is not a database");
    } finally {
      if (previous === undefined) delete process.env["TS_REVIEW_GRAPH_DB"];
      else process.env["TS_REVIEW_GRAPH_DB"] = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("db=null の理由の出し分け", () => {
  it("DB ファイルが無いときは従来どおり「未構築」を返す", () => {
    expect(formatDbUnavailableText(null)).toBe(GRAPH_NOT_BUILT_TEXT);

    const result = registerTools(null, "get_impact", { changed_file: "x.ts" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(GRAPH_NOT_BUILT_TEXT);
  });

  it("オープン失敗時は「未構築」と言わず理由を返す", () => {
    const failure = { dbPath: "/repo/.ts-review-graph/graph.db", message: "file is not a database" };
    const result = registerTools(null, "get_impact", { changed_file: "x.ts" }, failure);

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).not.toContain("グラフが未構築です");
    expect(text).toContain("グラフ DB を開けませんでした");
    expect(text).toContain("/repo/.ts-review-graph/graph.db");
    expect(text).toContain("file is not a database");
  });

  it("オープン失敗が ABI 不一致なら復旧手順まで返す", () => {
    const failure = { dbPath: "/repo/.ts-review-graph/graph.db", message: ABI_ERROR };
    const text = registerTools(null, "get_minimal_context", { changed_files: ["x.ts"] }, failure)
      .content[0]?.text ?? "";

    expect(text).toContain("ネイティブモジュールの Node ABI が一致していません。");
    expect(text).toContain("rm -rf -- '/Users/test/.npm/_npx/08af52269914770e'");
  });

  it("graph_status も未構築とオープン失敗を区別する", () => {
    const notBuilt = graphStatus(null, null);
    expect(notBuilt.isError).toBeUndefined();
    expect(notBuilt.content[0]?.text).toContain("グラフ未構築");

    const failed = graphStatus(null, {
      dbPath: "/repo/.ts-review-graph/graph.db",
      message: "file is not a database",
    });
    expect(failed.isError).toBe(true);
    expect(failed.content[0]?.text).not.toContain("グラフ未構築");
    expect(failed.content[0]?.text).toContain("file is not a database");
  });

  it("graph_status を registerTools 経由で呼んでも理由が届く", () => {
    const result = registerTools(null, "graph_status", {}, {
      dbPath: "/repo/.ts-review-graph/graph.db",
      message: "file is not a database",
    });
    expect(result.content[0]?.text).toContain("グラフ DB を開けませんでした");
  });

  it("build_graph はオープン失敗中でも復旧手段として到達できる", () => {
    // 実グラフを構築しないよう、存在しない tsconfig を渡す。
    // 「tsconfig not found」が返るのは db=null のゲートを通過して build_graph 本体へ
    // 到達した証跡であり、副作用（DB 生成・外部 DB の上書き）は起きない。
    const result = registerTools(null, "build_graph", { tsconfigs: ["/nonexistent/tsconfig.json"] }, {
      dbPath: "/repo/.ts-review-graph/graph.db",
      message: "file is not a database",
    });
    expect(result.content[0]?.text).toContain("tsconfig.json not found");
    expect(result.content[0]?.text).not.toContain("グラフ DB を開けませんでした");
    expect(result.content[0]?.text).not.toBe(GRAPH_NOT_BUILT_TEXT);
  });
});
