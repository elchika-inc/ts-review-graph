import { statSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
import { readMeta, SCHEMA_VERSION } from "./meta.js";
import { toProjectAbsolute, toProjectRelative } from "./paths.js";

export type GraphHealth =
  | { status: "ok" }
  | { status: "mismatch"; reason: "legacy_schema" | "tsconfig_drift"; detail: string }
  | { status: "drift"; staleFiles: number; totalFiles: number };

const CONFIG_REL_PATH = ".ts-review-graph/config.json";

function readConfiguredTsconfigs(projectRoot: string): string[] | null {
  try {
    const raw = readFileSync(path.join(projectRoot, CONFIG_REL_PATH), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const list = (parsed as { tsconfigs?: unknown }).tsconfigs;
    if (!Array.isArray(list)) return null;
    if (!list.every((v) => typeof v === "string")) return null;
    return (list as string[]).map((value) => toProjectRelative(projectRoot, value)).sort();
  } catch {
    return null;
  }
}

// 検疫。ゲート系として振る舞うため、客観的に壊れている状態（mismatch）は
// 呼び出し側で fail-closed に倒すこと。drift は警告に留める。
export function checkGraphHealth(db: Db, projectRoot: string): GraphHealth {
  // 1. スキーマ版
  const meta = readMeta(db);
  if (meta === null) {
    return {
      status: "mismatch",
      reason: "legacy_schema",
      detail: "meta テーブルがありません（旧形式のグラフです）",
    };
  }
  if (meta.schemaVersion !== SCHEMA_VERSION) {
    return {
      status: "mismatch",
      reason: "legacy_schema",
      detail: `schema_version=${meta.schemaVersion}（期待値 ${SCHEMA_VERSION}）`,
    };
  }

  // 2. 設定ドリフト — 検証不能（config.json 不在）も通さない
  const configured = readConfiguredTsconfigs(projectRoot);
  if (configured === null) {
    return {
      status: "mismatch",
      reason: "tsconfig_drift",
      detail: `${CONFIG_REL_PATH} が読めません — グラフのスコープを検証できません`,
    };
  }
  const recorded = [...meta.tsconfigs].sort();
  if (JSON.stringify(configured) !== JSON.stringify(recorded)) {
    return {
      status: "mismatch",
      reason: "tsconfig_drift",
      detail: `config.json=[${configured.join(", ")}] / グラフ構築時=[${recorded.join(", ")}]`,
    };
  }

  // 3. ファイルドリフト
  // 注意: グラフに登録済みの既知ファイルのみを検査する。
  // 構築後に新規追加されたファイルは検出しない（include の glob が高コストなため）。
  // その穴は get_minimal_context の NOT IN GRAPH 表示で補う。
  const rows = db
    .prepare("SELECT file, updated_at FROM file_hashes")
    .all() as { file: string; updated_at: number }[];

  let staleFiles = 0;
  for (const row of rows) {
    try {
      const st = statSync(toProjectAbsolute(projectRoot, row.file));
      if (st.mtimeMs > row.updated_at) staleFiles++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        // グラフに残っているがディスクに無い = ドリフト
        staleFiles++;
      } else {
        // 権限・symlink loop・I/O 障害など検証不能な状態はゲートで通さない。
        throw err;
      }
    }
  }

  if (staleFiles > 0) {
    return { status: "drift", staleFiles, totalFiles: rows.length };
  }
  return { status: "ok" };
}
