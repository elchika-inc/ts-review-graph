import { describe, expect, it } from "vitest";
import { formatNpxAbiMismatchGuidance } from "../src/index.js";

// ABI 診断は CLI と MCP サーバーの双方から参照される共通実装。
// core の公開 API から消えると、どちらかの経路で原因不明の「未構築」に戻る。
describe("formatNpxAbiMismatchGuidance (core の公開 API)", () => {
  it("core の index から export されている", () => {
    expect(typeof formatNpxAbiMismatchGuidance).toBe("function");
  });

  it("ABI 不一致では npx キャッシュの削除コマンドを案内する", () => {
    const message = `The module '/Users/test user/.npm/_npx/08af52269914770e/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using NODE_MODULE_VERSION 137.`;

    expect(formatNpxAbiMismatchGuidance(message)).toEqual([
      "ネイティブモジュールの Node ABI が一致していません。",
      "次の npx キャッシュを削除してから、同じコマンドを再実行してください:",
      "rm -rf -- '/Users/test user/.npm/_npx/08af52269914770e'",
    ]);
  });

  it("ABI 不一致でもパスを抽出できなければ一般的な案内に留める", () => {
    expect(
      formatNpxAbiMismatchGuidance("NODE_MODULE_VERSION 137 と 127 が一致しません")
    ).toEqual([
      "ネイティブモジュールの Node ABI が一致していません。",
      "該当する npx キャッシュを削除してから、同じコマンドを再実行してください。",
    ]);
  });

  it("NODE_MODULE_VERSION を含まないエラーでは案内しない", () => {
    expect(formatNpxAbiMismatchGuidance("file is not a database")).toEqual([]);
  });
});
