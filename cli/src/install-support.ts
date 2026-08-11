export interface GitignoreUpdate {
  content: string;
  changed: boolean;
}

const gitignoreHeader = "# ts-review-graph (graph.db はビルド成果物、config.json はコミット対象)";
const graphIgnoreLines = [
  ".ts-review-graph/graph.db",
  ".ts-review-graph/graph.db-wal",
  ".ts-review-graph/graph.db-shm",
] as const;
const graphIgnoreBlock = `${gitignoreHeader}\n${graphIgnoreLines.join("\n")}\n`;

export function updateGraphGitignore(content: string): GitignoreUpdate {
  const lines = content.split(/\r?\n/);
  const complete =
    lines.filter((line) => line === gitignoreHeader).length === 1 &&
    graphIgnoreLines.every(
      (target) => lines.filter((line) => line === target).length === 1
    ) &&
    !lines.includes(".ts-review-graph/") &&
    !lines.includes(".ts-review-graph/graph.db*");

  if (complete) {
    return { content, changed: false };
  }

  const obsoleteLines = new Set<string>([
    "# ts-review-graph",
    gitignoreHeader,
    ".ts-review-graph/",
    ".ts-review-graph/graph.db*",
    ...graphIgnoreLines,
  ]);
  const retained = lines.filter((line) => !obsoleteLines.has(line));
  while (retained.at(-1) === "") retained.pop();

  const prefix = retained.length > 0 ? `${retained.join("\n")}\n\n` : "";
  return {
    content: `${prefix}${graphIgnoreBlock}`,
    changed: true,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function extractNpxCacheDirectory(message: string): string | null {
  const singleQuoted = message.match(
    /'(\/[^'\r\n]*\/_npx\/[A-Za-z0-9_-]+)(?:\/[^'\r\n]*)?'/
  );
  const doubleQuoted = message.match(
    /"(\/[^"\r\n]*\/_npx\/[A-Za-z0-9_-]+)(?:\/[^"\r\n]*)?"/
  );
  const unquoted = message.match(
    /(?:^|[ \t])(\/[^\s\r\n]*\/_npx\/[A-Za-z0-9_-]+)(?:\/[^\s\r\n]*)?/
  );
  return singleQuoted?.[1] ?? doubleQuoted?.[1] ?? unquoted?.[1] ?? null;
}

export function formatNpxAbiMismatchGuidance(message: string): string[] {
  if (!message.includes("NODE_MODULE_VERSION")) return [];

  const cacheDirectory = extractNpxCacheDirectory(message);
  if (!cacheDirectory) {
    return [
      "ネイティブモジュールの Node ABI が一致していません。",
      "該当する npx キャッシュを削除してから install を再試行してください。",
    ];
  }

  return [
    "ネイティブモジュールの Node ABI が一致していません。",
    "次の npx キャッシュを削除してから install を再試行してください:",
    `rm -rf -- ${shellQuote(cacheDirectory)}`,
  ];
}
