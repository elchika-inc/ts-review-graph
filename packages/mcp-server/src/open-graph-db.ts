import type { DbOpenFailure } from "./tools/db-unavailable.js";

export interface GraphDbState<T> {
  db: T | null;
  failure: DbOpenFailure | null;
}

/**
 * グラフ DB を開き、失敗理由を握りつぶさずに返す。
 *
 * 起動時と build_graph 後の再オープンで同じ規則を使うために純関数として切り出している
 * （`openDb` を注入できるので、native モジュール無しで遷移をテストできる）。
 * `failure` が null かつ `db` も null なのは「DB ファイルが無い＝本当に未構築」のときだけ。
 */
export function openGraphDb<T>(
  dbPath: string,
  open: (path: string) => T
): GraphDbState<T> {
  try {
    return { db: open(dbPath), failure: null };
  } catch (err) {
    return {
      db: null,
      failure: { dbPath, message: err instanceof Error ? err.message : String(err) },
    };
  }
}
