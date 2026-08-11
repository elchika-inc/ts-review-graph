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
