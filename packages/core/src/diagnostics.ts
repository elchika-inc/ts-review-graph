// DB オープン失敗の診断メッセージ。CLI (ts-review-graph install/build/update/status) と
// MCP サーバー (degraded mode) の双方から参照するため core に置く。
// 片側にだけ診断があると、同じ ABI 不一致が経路によって「原因不明」に見える。

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
      "該当する npx キャッシュを削除してから、同じコマンドを再実行してください。",
    ];
  }

  return [
    "ネイティブモジュールの Node ABI が一致していません。",
    "次の npx キャッシュを削除してから、同じコマンドを再実行してください:",
    `rm -rf -- ${shellQuote(cacheDirectory)}`,
  ];
}
