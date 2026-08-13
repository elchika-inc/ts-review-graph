// ABI 診断は本物の core 実装をそのまま使う（ここで stub すると診断テストが空洞になる）。
// native モジュールを読み込まないよう、index ではなく diagnostics を直接参照する。
export { formatNpxAbiMismatchGuidance } from "../../../packages/core/dist/diagnostics.js";

export function openDb() {
  throw new Error(process.env.TS_REVIEW_GRAPH_TEST_DB_ERROR ?? "database is locked");
}

export function toProjectRelative(projectRoot, filePath) {
  const prefix = `${projectRoot}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}

export function buildFullGraph() {
  throw new Error("openDb より後へ到達してはいけません");
}

export function updateFile() {
  throw new Error("openDb より後へ到達してはいけません");
}

export function checkGraphHealth() {
  throw new Error("openDb より後へ到達してはいけません");
}
