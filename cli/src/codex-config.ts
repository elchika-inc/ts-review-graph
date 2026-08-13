// Codex の project 単位設定 (.codex/config.toml) へ MCP サーバー登録を追記する。
//
// 依存を増やさない方針のため TOML ライブラリは使わず、行ベースの走査で
// `[mcp_servers.ts-review-graph]` セクションだけを最小限に書き換える。
// 利用者の既存ファイルを書き換える処理なので、少しでも解釈できない記法に
// 出会ったら CodexConfigParseError を投げて **書き込みを行わない**（fail-closed）。

export class CodexConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexConfigParseError";
  }
}

export interface CodexConfigUpdate {
  content: string;
  changed: boolean;
}

const SERVER_TABLE_PATH = ["mcp_servers", "ts-review-graph"] as const;

// --- キーパスの読み取り -------------------------------------------------

function skipWs(source: string, index: number): number {
  let i = index;
  while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;
  return i;
}

function readKeyPart(source: string, index: number): { part: string; next: number } | null {
  if (source[index] === '"') {
    let i = index + 1;
    let out = "";
    while (i < source.length) {
      if (source[i] === "\\") {
        // エスケープの厳密な復号は不要（比較対象は ASCII キーのみ）。
        // \" を終端と誤認しないよう2文字進めることだけが目的。
        out += source[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (source[i] === '"') return { part: out, next: i + 1 };
      out += source[i];
      i++;
    }
    return null;
  }
  if (source[index] === "'") {
    const end = source.indexOf("'", index + 1);
    if (end === -1) return null;
    return { part: source.slice(index + 1, end), next: end + 1 };
  }
  const bare = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
  if (!bare) return null;
  return { part: bare[0], next: index + bare[0].length };
}

function readKeyPath(source: string, index: number): { parts: string[]; next: number } | null {
  const parts: string[] = [];
  let i = index;
  for (;;) {
    i = skipWs(source, i);
    const part = readKeyPart(source, i);
    if (!part) return null;
    parts.push(part.part);
    i = skipWs(source, part.next);
    if (source[i] === ".") {
      i++;
      continue;
    }
    return { parts, next: i };
  }
}

// --- 行走査 -------------------------------------------------------------

interface ScanState {
  depth: number;
  multiline: '"""' | "'''" | null;
}

/** 1行を走査して括弧の深さと複数行文字列の状態を更新する。解釈できない行では throw する。 */
function scanLine(line: string, state: ScanState): void {
  let i = 0;
  if (state.multiline) {
    const close = line.indexOf(state.multiline);
    if (close === -1) return;
    i = close + 3;
    state.multiline = null;
  }
  while (i < line.length) {
    const char = line[i]!;
    if (char === "#") return; // 文字列外の # は行コメント
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      const delimiter = line.startsWith('"""', i) ? '"""' : "'''";
      const close = line.indexOf(delimiter, i + 3);
      if (close === -1) {
        state.multiline = delimiter;
        return;
      }
      i = close + 3;
      continue;
    }
    if (char === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= line.length) {
          throw new CodexConfigParseError("基本文字列が行内で閉じられていません");
        }
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === '"') break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (char === "'") {
      const close = line.indexOf("'", i + 1);
      if (close === -1) {
        throw new CodexConfigParseError("リテラル文字列が行内で閉じられていません");
      }
      i = close + 1;
      continue;
    }
    if (char === "[" || char === "{") {
      state.depth++;
      i++;
      continue;
    }
    if (char === "]" || char === "}") {
      state.depth--;
      if (state.depth < 0) {
        throw new CodexConfigParseError("括弧の対応が取れていません");
      }
      i++;
      continue;
    }
    i++;
  }
}

// --- ドキュメントの分解 -------------------------------------------------

type Item =
  | { kind: "header"; parts: string[]; arrayOfTables: boolean; start: number; end: number }
  | { kind: "key"; parts: string[]; start: number; end: number }
  | { kind: "other"; start: number; end: number };

function parseHeader(line: string): { parts: string[]; arrayOfTables: boolean } {
  let i = skipWs(line, 0);
  const arrayOfTables = line.startsWith("[[", i);
  i += arrayOfTables ? 2 : 1;

  const keyPath = readKeyPath(line, i);
  if (!keyPath) throw new CodexConfigParseError(`テーブル見出しを解釈できません: ${line.trim()}`);

  i = skipWs(line, keyPath.next);
  const closing = arrayOfTables ? "]]" : "]";
  if (!line.startsWith(closing, i)) {
    throw new CodexConfigParseError(`テーブル見出しが閉じられていません: ${line.trim()}`);
  }
  i = skipWs(line, i + closing.length);
  if (i < line.length && line[i] !== "#") {
    throw new CodexConfigParseError(`テーブル見出しの後に余分な記述があります: ${line.trim()}`);
  }
  return { parts: keyPath.parts, arrayOfTables };
}

function parseItems(lines: string[]): Item[] {
  const items: Item[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      items.push({ kind: "other", start: i, end: i });
      i++;
      continue;
    }

    if (trimmed.startsWith("[")) {
      const header = parseHeader(line);
      items.push({ kind: "header", ...header, start: i, end: i });
      i++;
      continue;
    }

    // key = value。複数行にまたがる配列・インラインテーブル・複数行文字列を1単位として消費する。
    // これにより配列内の `["a"],` のような行がテーブル見出しと誤認されない。
    const keyPath = readKeyPath(line, 0);
    if (!keyPath || line[skipWs(line, keyPath.next)] !== "=") {
      throw new CodexConfigParseError(`キーと値の行を解釈できません: ${trimmed}`);
    }

    const state: ScanState = { depth: 0, multiline: null };
    let end = i;
    for (;;) {
      scanLine(lines[end]!, state);
      if (state.depth === 0 && state.multiline === null) break;
      end++;
      if (end >= lines.length) {
        throw new CodexConfigParseError(`値が閉じられないままファイルが終わっています: ${trimmed}`);
      }
    }

    items.push({ kind: "key", parts: keyPath.parts, start: i, end });
    i = end + 1;
  }
  return items;
}

// --- 書き換え -----------------------------------------------------------

function startsWithPath(candidate: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((part, index) => candidate[index] === part);
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && startsWithPath(a, b);
}

function buildArgsLines(packageSpec: string): string[] {
  return ["args = [", `    "-y",`, `    "${packageSpec}",`, "]"];
}

function buildSectionLines(packageSpec: string): string[] {
  return [
    `[${SERVER_TABLE_PATH.join(".")}]`,
    `command = "npx"`,
    ...buildArgsLines(packageSpec),
  ];
}

/**
 * `.codex/config.toml` の内容へ ts-review-graph の MCP サーバー登録を反映する。
 *
 * - セクションが無ければ末尾に追記する
 * - あれば command / args だけを正規化し、利用者が足した他のキーは残す
 * - 自分のエントリの env（旧 TS_REVIEW_GRAPH_DB の絶対パスを含む）は除去する
 * - 他のセクション・他の mcp_servers エントリには触れない
 *
 * @throws {CodexConfigParseError} 解釈できない記法に出会った場合（呼び出し側は書き込まないこと）
 */
export function updateCodexConfig(current: string, packageSpec: string): CodexConfigUpdate {
  const eol = /\r\n/.test(current) ? "\r\n" : "\n";
  const lines = current.split(/\r?\n/);
  const items = parseItems(lines);

  let currentTable: string[] = [];
  let sectionIndex = -1;
  const subTableIndexes: number[] = [];

  for (const [index, item] of items.entries()) {
    if (item.kind === "header") {
      if (startsWithPath(item.parts, SERVER_TABLE_PATH)) {
        if (item.arrayOfTables) {
          throw new CodexConfigParseError(
            "[[mcp_servers.ts-review-graph]] (array of tables) は自動更新できません"
          );
        }
        if (samePath(item.parts, SERVER_TABLE_PATH)) {
          if (sectionIndex !== -1) {
            throw new CodexConfigParseError(
              "[mcp_servers.ts-review-graph] が複数回定義されています"
            );
          }
          sectionIndex = index;
        } else {
          subTableIndexes.push(index);
        }
      }
      currentTable = item.parts;
      continue;
    }

    if (item.kind !== "key") continue;

    // 自分のセクション（およびその子テーブル）の外側から
    // mcp_servers.ts-review-graph.* を定義している記法は安全に更新できない。
    if (startsWithPath(currentTable, SERVER_TABLE_PATH)) continue;
    const absolute = [...currentTable, ...item.parts];
    if (startsWithPath(absolute, SERVER_TABLE_PATH)) {
      throw new CodexConfigParseError(
        "mcp_servers.ts-review-graph がインラインテーブル/ドット記法で定義されています。手動で整理してください"
      );
    }
  }

  const dropped = new Set<number>();
  for (const index of subTableIndexes) {
    const header = items[index]!;
    if (header.kind !== "header") continue;
    // 自分のエントリ配下の env サブテーブルだけ落とす（env は書かない方針のため）
    if (!samePath(header.parts, [...SERVER_TABLE_PATH, "env"])) continue;
    dropped.add(index);
    for (let i = index + 1; i < items.length && items[i]!.kind !== "header"; i++) {
      dropped.add(i);
    }
  }

  const output: string[] = [];
  for (const [index, item] of items.entries()) {
    if (dropped.has(index)) continue;

    if (index === sectionIndex) {
      output.push(...lines.slice(item.start, item.end + 1));
      const bodyEnd = nextHeaderIndex(items, index);
      output.push(...rewriteSectionBody(items, lines, index + 1, bodyEnd, dropped, packageSpec));
      continue;
    }
    if (sectionIndex !== -1 && index > sectionIndex && index < nextHeaderIndex(items, sectionIndex)) {
      continue; // セクション本体は rewriteSectionBody が出力済み
    }
    output.push(...lines.slice(item.start, item.end + 1));
  }

  if (sectionIndex === -1) {
    while (output.at(-1) === "") output.pop();
    if (output.length > 0) output.push("");
    output.push(...buildSectionLines(packageSpec));
  }

  while (output.at(-1) === "") output.pop();
  const content = output.length > 0 ? `${output.join(eol)}${eol}` : "";
  return { content, changed: content !== current };
}

function nextHeaderIndex(items: Item[], from: number): number {
  for (let i = from + 1; i < items.length; i++) {
    if (items[i]!.kind === "header") return i;
  }
  return items.length;
}

function rewriteSectionBody(
  items: Item[],
  lines: string[],
  start: number,
  end: number,
  dropped: Set<number>,
  packageSpec: string
): string[] {
  const body: string[] = [];
  let sawCommand = false;
  let sawArgs = false;

  for (let index = start; index < end; index++) {
    if (dropped.has(index)) continue;
    const item = items[index]!;

    if (item.kind === "key") {
      const [head, ...rest] = item.parts;
      if (head === "command" && rest.length === 0) {
        if (sawCommand) {
          throw new CodexConfigParseError("[mcp_servers.ts-review-graph] に command が重複しています");
        }
        sawCommand = true;
        body.push(`command = "npx"`);
        continue;
      }
      if (head === "args" && rest.length === 0) {
        if (sawArgs) {
          throw new CodexConfigParseError("[mcp_servers.ts-review-graph] に args が重複しています");
        }
        sawArgs = true;
        body.push(...buildArgsLines(packageSpec));
        continue;
      }
      // env（インラインテーブル・env.KEY のドット記法とも）は書かない方針のため除去する
      if (head === "env") continue;
    }

    body.push(...lines.slice(item.start, item.end + 1));
  }

  const missing: string[] = [];
  if (!sawCommand) missing.push(`command = "npx"`);
  if (!sawArgs) missing.push(...buildArgsLines(packageSpec));
  return [...missing, ...body];
}
