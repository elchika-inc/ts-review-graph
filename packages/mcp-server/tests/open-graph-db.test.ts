import { describe, expect, it } from "vitest";
import { openGraphDb } from "../src/open-graph-db.js";

const DB_PATH = "/repo/.ts-review-graph/graph.db";
const ABI_ERROR =
  "The module '/Users/test/.npm/_npx/08af52269914770e/node_modules/x.node' uses NODE_MODULE_VERSION 137";

describe("openGraphDb", () => {
  it("成功時は db を返し失敗理由を持たない", () => {
    const handle = { marker: "db" };
    expect(openGraphDb(DB_PATH, () => handle)).toEqual({ db: handle, failure: null });
  });

  it("失敗時は db を返さず、パスとメッセージを保持する", () => {
    const state = openGraphDb(DB_PATH, () => {
      throw new Error("file is not a database");
    });

    expect(state.db).toBeNull();
    expect(state.failure).toEqual({ dbPath: DB_PATH, message: "file is not a database" });
  });

  it("Error 以外が throw されても文字列化して理由を残す", () => {
    const state = openGraphDb(DB_PATH, () => {
      throw "raw string failure";
    });

    expect(state.failure?.message).toBe("raw string failure");
  });
});

describe("openGraphDb の状態遷移契約", () => {
  // server.ts は「起動時」と「build_graph 後の再オープン」で openGraphDb を共有する。
  // ここで固定するのは純関数の契約で、server.ts の配線そのものは
  // tests/server-degraded.test.ts が実プロセスで検証する。
  it("degraded で起動しても再オープン成功で理由がクリアされる", () => {
    let attempt = 0;
    const open = () => {
      attempt++;
      if (attempt === 1) throw new Error(ABI_ERROR);
      return { marker: "db" };
    };

    const start = openGraphDb(DB_PATH, open);
    expect(start.db).toBeNull();
    expect(start.failure?.message).toBe(ABI_ERROR);

    const afterBuild = openGraphDb(DB_PATH, open);
    expect(afterBuild.db).not.toBeNull();
    expect(afterBuild.failure).toBeNull();
  });

  it("未構築から build 後に再オープン失敗すると理由が設定される", () => {
    const afterBuild = openGraphDb(DB_PATH, () => {
      throw new Error(ABI_ERROR);
    });

    expect(afterBuild.db).toBeNull();
    expect(afterBuild.failure?.message).toBe(ABI_ERROR);
  });
});
