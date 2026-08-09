import type { Db } from "./db.js";

// meta を持たない DB は暗黙の v1（絶対パス保存）とみなす。
// 値を上げたときは、旧 DB が checkGraphHealth で legacy_schema として拒否される。
export const SCHEMA_VERSION = "2";

export interface GraphMeta {
  schemaVersion: string;
  tsconfigs: string[];
  builtAt: number;
  builtRoot: string;
}

export function writeMeta(db: Db, meta: GraphMeta): void {
  const stmt = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  const sorted = [...meta.tsconfigs].sort();
  db.transaction(() => {
    stmt.run("schema_version", meta.schemaVersion);
    stmt.run("tsconfigs", JSON.stringify(sorted));
    stmt.run("built_at", String(meta.builtAt));
    stmt.run("built_root", meta.builtRoot);
  })();
}

export function readMeta(db: Db): GraphMeta | null {
  let rows: { key: string; value: string }[];
  try {
    rows = db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
  } catch {
    // meta テーブル自体が無い DB（v1）
    return null;
  }
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const schemaVersion = map.get("schema_version");
  const tsconfigsRaw = map.get("tsconfigs");
  const builtAtRaw = map.get("built_at");
  const builtRoot = map.get("built_root");
  if (schemaVersion === undefined || tsconfigsRaw === undefined ||
      builtAtRaw === undefined || builtRoot === undefined) {
    return null;
  }
  let tsconfigs: string[];
  try {
    const parsed: unknown = JSON.parse(tsconfigsRaw);
    if (!Array.isArray(parsed)) return null;
    tsconfigs = parsed as string[];
  } catch {
    return null;
  }
  const builtAt = Number(builtAtRaw);
  if (!Number.isFinite(builtAt)) return null;
  return { schemaVersion, tsconfigs, builtAt, builtRoot };
}
