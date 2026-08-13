import { describe, expect, it } from "vitest";
import { formatNpxAbiMismatchGuidance } from "@elchika-inc/ts-review-graph-core";
import {
  formatDbOpenFailureLines,
  formatDbUnavailableText,
  GRAPH_NOT_BUILT_TEXT,
} from "../src/tools/db-unavailable.js";
import { registerTools } from "../src/tools/index.js";
import { graphStatus } from "../src/tools/graph-status.js";

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
    const notBuilt = graphStatus(null);
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
    // 未構築時の分岐で弾かれないこと（引数不足による失敗は build_graph 本体まで到達した証跡）
    const result = registerTools(null, "build_graph", {}, {
      dbPath: "/repo/.ts-review-graph/graph.db",
      message: "file is not a database",
    });
    expect(result.content[0]?.text).not.toContain("グラフ DB を開けませんでした");
    expect(result.content[0]?.text).not.toBe(GRAPH_NOT_BUILT_TEXT);
  });
});
