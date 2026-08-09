import { describe, expect, it } from "vitest";
import {
  formatNpxAbiMismatchGuidance,
  updateGraphGitignore,
} from "../src/install-support.js";

const expectedIgnoreBlock = `# ts-review-graph (graph.db はビルド成果物、config.json はコミット対象)
.ts-review-graph/graph.db
.ts-review-graph/graph.db-wal
.ts-review-graph/graph.db-shm
`;

describe("updateGraphGitignore", () => {
  it("DB と WAL/SHM をまとめて追記する", () => {
    expect(updateGraphGitignore("node_modules\n")).toEqual({
      content: `node_modules\n\n${expectedIgnoreBlock}`,
      changed: true,
    });
  });

  it("graph.db だけが既存でも不足する WAL/SHM を補う", () => {
    const current = `node_modules\n\n# ts-review-graph (graph.db はビルド成果物、config.json はコミット対象)\n.ts-review-graph/graph.db\n`;
    expect(updateGraphGitignore(current)).toEqual({
      content: `node_modules\n\n${expectedIgnoreBlock}`,
      changed: true,
    });
  });

  it("全行が既存なら二重追記しない", () => {
    const current = `node_modules\n\n${expectedIgnoreBlock}`;
    expect(updateGraphGitignore(current)).toEqual({
      content: current,
      changed: false,
    });
  });

  it("旧形式のディレクトリ全体 ignore を3ファイルの ignoreへ置き換える", () => {
    const current = "node_modules\n\n# ts-review-graph\n.ts-review-graph/\n";
    expect(updateGraphGitignore(current)).toEqual({
      content: `node_modules\n\n${expectedIgnoreBlock}`,
      changed: true,
    });
  });
});

describe("formatNpxAbiMismatchGuidance", () => {
  it("ABI 不一致ではエラー中の npx キャッシュを安全な削除コマンドで案内する", () => {
    const message = `The module '/Users/test user/.npm/_npx/08af52269914770e/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using NODE_MODULE_VERSION 137.`;

    expect(formatNpxAbiMismatchGuidance(message)).toEqual([
      "ネイティブモジュールの Node ABI が一致していません。",
      "次の npx キャッシュを削除してから install を再試行してください:",
      "rm -rf -- '/Users/test user/.npm/_npx/08af52269914770e'",
    ]);
  });

  it("ABI 不一致でもパスを抽出できなければ一般的な案内に留める", () => {
    const message = "NODE_MODULE_VERSION 137 と NODE_MODULE_VERSION 127 が一致しません";

    expect(formatNpxAbiMismatchGuidance(message)).toEqual([
      "ネイティブモジュールの Node ABI が一致していません。",
      "該当する npx キャッシュを削除してから install を再試行してください。",
    ]);
  });

  it("空白を含む unquoted path の途中から削除対象を抽出しない", () => {
    const message = "NODE_MODULE_VERSION /Users/test user/.npm/_npx/08af52269914770e/node_modules/addon.node";

    expect(formatNpxAbiMismatchGuidance(message)).toEqual([
      "ネイティブモジュールの Node ABI が一致していません。",
      "該当する npx キャッシュを削除してから install を再試行してください。",
    ]);
  });

  it("NODE_MODULE_VERSION を含まないエラーでは案内しない", () => {
    expect(formatNpxAbiMismatchGuidance("database is locked")).toEqual([]);
  });
});
