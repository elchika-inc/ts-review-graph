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

// 旧 version が .mcp.json から写した絶対パス。Codex 用エントリには env を書かない方針のため除去する。
// 利用者が置いた他の env キーには触れない。
const STALE_ENV_KEY = "TS_REVIEW_GRAPH_DB";

// --- キーパスの読み取り -------------------------------------------------

function skipWs(source: string, index: number): number {
  let i = index;
  while (i < source.length && (source[i] === " " || source[i] === "\t")) i++;
  return i;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

/**
 * 基本文字列キーのエスケープを復号する。
 * 復号しないと `"ts-review-graph"` が自セクションと認識されず、
 * 重複セクションを追記して TOML を壊す（fail-closed 設計の中の唯一の fail-open だった）。
 */
function decodeEscape(source: string, i: number): { text: string; next: number } | null {
  const marker = source[i + 1];
  if (marker === undefined) return null;
  if (marker in SIMPLE_ESCAPES) return { text: SIMPLE_ESCAPES[marker]!, next: i + 2 };
  if (marker === "u" || marker === "U") {
    const width = marker === "u" ? 4 : 8;
    const digits = source.slice(i + 2, i + 2 + width);
    if (digits.length !== width || !/^[0-9A-Fa-f]+$/.test(digits)) return null;
    return { text: String.fromCodePoint(Number.parseInt(digits, 16)), next: i + 2 + width };
  }
  return null;
}

function readKeyPart(source: string, index: number): { part: string; next: number } | null {
  if (source[index] === '"') {
    let i = index + 1;
    let out = "";
    while (i < source.length) {
      if (source[i] === "\\") {
        const decoded = decodeEscape(source, i);
        if (!decoded) return null;
        out += decoded.text;
        i = decoded.next;
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

// --- 文字列全体の走査（インラインテーブルの部分編集用） -----------------
//
// scanLine は「行をまたぐ複数行文字列」を状態として持つため行単位でしか使えない。
// インラインテーブルの中身は1つの文字列として扱うので、閉じない文字列は即エラーでよい。

/** text[i] が文字列・コメントの開始ならその直後の位置を返す。該当しなければ null。 */
function skipAtomic(text: string, i: number): number | null {
  const char = text[i];
  if (char === "#") {
    const newline = text.indexOf("\n", i);
    return newline === -1 ? text.length : newline;
  }
  if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
    const delimiter = text.startsWith('"""', i) ? '"""' : "'''";
    const close = text.indexOf(delimiter, i + 3);
    if (close === -1) throw new CodexConfigParseError("複数行文字列が閉じられていません");
    return close + 3;
  }
  if (char === '"') {
    let j = i + 1;
    for (;;) {
      if (j >= text.length) throw new CodexConfigParseError("基本文字列が閉じられていません");
      if (text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text[j] === '"') return j + 1;
      j++;
    }
  }
  if (char === "'") {
    const close = text.indexOf("'", i + 1);
    if (close === -1) throw new CodexConfigParseError("リテラル文字列が閉じられていません");
    return close + 1;
  }
  return null;
}

/** open 位置の `{` に対応する `}` の位置を返す。見つからなければ null。 */
function findMatchingBrace(text: string, open: number): number | null {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const skipped = skipAtomic(text, i);
    if (skipped !== null) {
      i = skipped;
      continue;
    }
    const char = text[i]!;
    if (char === "[" || char === "{") depth++;
    if (char === "]" || char === "}") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return null;
    }
    i++;
  }
  return null;
}

/** インラインテーブルの中身を、深さ0のカンマで要素へ分割する。 */
function splitInlineTableEntries(body: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const skipped = skipAtomic(body, i);
    if (skipped !== null) {
      i = skipped;
      continue;
    }
    const char = body[i]!;
    if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth--;
    else if (char === "," && depth === 0) {
      entries.push(body.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  const tail = body.slice(start);
  if (tail.trim() !== "") entries.push(tail);
  return entries;
}

/**
 * `env = { ... }` から STALE_ENV_KEY だけを取り除く。
 * - 該当キーが無い / インラインテーブルでない → undefined（元の行をそのまま残す）
 * - 取り除いた結果 空になった → null（env キーごと削除する）
 * - それ以外 → 書き換えた1行
 */
function removeStaleEnvKey(raw: string): string | null | undefined {
  // 値の開始位置はキー→`=`→空白と辿って決める。raw.indexOf("{") では
  // `env = "a{b"` のように文字列内の波括弧を拾い、妥当な TOML を壊す。
  const keyPath = readKeyPath(raw, 0);
  if (!keyPath) return undefined;
  let cursor = skipWs(raw, keyPath.next);
  if (raw[cursor] !== "=") return undefined;
  cursor = skipWs(raw, cursor + 1);
  if (raw[cursor] !== "{") return undefined; // インラインテーブル以外には触らない

  const close = findMatchingBrace(raw, cursor);
  if (close === null) return undefined;

  const entries = splitInlineTableEntries(raw.slice(cursor + 1, close));
  const kept = entries.filter((entry) => {
    const entryKey = readKeyPath(entry, 0);
    return !(entryKey && entryKey.parts.length === 1 && entryKey.parts[0] === STALE_ENV_KEY);
  });

  if (kept.length === entries.length) return undefined;
  if (kept.length === 0) return null;

  // インデントと行末コメントは利用者のものなので持ち越す
  const indent = raw.slice(0, raw.length - raw.trimStart().length);
  const trailing = raw.slice(close + 1);
  return `${indent}env = { ${kept.map((entry) => entry.trim()).join(", ")} }${trailing}`;
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
  // Codex (toml-rs) は BOM 付きの config.toml を問題なくロードする。
  // 剥がさずに走査すると先頭の U+FEFF を見出しの一部と読んで throw し、
  // 利用者側は壊れていないのに install 全体が中止する。出力時に付け直す。
  const BOM = "\uFEFF";
  const bom = current.startsWith(BOM) ? BOM : "";
  const source = bom ? current.slice(1) : current;

  const eol = /\r\n/.test(source) ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
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
    // mcp_servers.ts-review-graph を値として定義している記法は安全に更新できない。
    // 判定は双方向に行う必要がある:
    //   - キーが対象パスの子孫  … [mcp_servers] + `ts-review-graph = { ... }`
    //   - キーが対象パスの祖先  … ルートの `mcp_servers = { ... }`
    // 後者を見落とすと、インラインテーブルへ後からテーブル見出しを足す
    // TOML 仕様違反のファイルを書き出し、Codex がその project 設定を丸ごと読めなくなる。
    if (startsWithPath(currentTable, SERVER_TABLE_PATH)) continue;
    const absolute = [...currentTable, ...item.parts];
    if (
      startsWithPath(absolute, SERVER_TABLE_PATH) ||
      startsWithPath(SERVER_TABLE_PATH, absolute)
    ) {
      throw new CodexConfigParseError(
        `${absolute.join(".")} が値（インラインテーブル/ドット記法）として定義されています。` +
          "[mcp_servers.ts-review-graph] のテーブル見出し記法へ手動で整理してください"
      );
    }
  }

  // [mcp_servers.ts-review-graph.env] からは古い TS_REVIEW_GRAPH_DB の行だけを落とす。
  // 「次の見出しまで」を一括で落とすと、次セクションの前置コメントまで巻き添えにする。
  const dropped = new Set<number>();
  for (const index of subTableIndexes) {
    const header = items[index]!;
    if (header.kind !== "header") continue;
    if (!samePath(header.parts, [...SERVER_TABLE_PATH, "env"])) continue;

    let remainingKeys = 0;
    for (let i = index + 1; i < items.length && items[i]!.kind !== "header"; i++) {
      const entry = items[i]!;
      if (entry.kind !== "key") continue;
      if (entry.parts.length === 1 && entry.parts[0] === STALE_ENV_KEY) {
        dropped.add(i);
        continue;
      }
      remainingKeys++;
    }
    // 残るキーが無くなったサブテーブルは見出しごと落とす（コメント・空行は残す）
    if (remainingKeys === 0) dropped.add(index);
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
  const body = output.length > 0 ? `${output.join(eol)}${eol}` : "";
  const content = `${bom}${body}`;
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
        // 利用者が変えた command は保持する（更新するのは args の version だけ）
        body.push(...lines.slice(item.start, item.end + 1));
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
      if (head === "env") {
        // 古い TS_REVIEW_GRAPH_DB だけを除去し、利用者が置いた他の env キーは残す
        if (rest.length > 0) {
          if (rest.length === 1 && rest[0] === STALE_ENV_KEY) continue; // env.TS_REVIEW_GRAPH_DB
          body.push(...lines.slice(item.start, item.end + 1));
          continue;
        }
        const rewritten = removeStaleEnvKey(lines.slice(item.start, item.end + 1).join("\n"));
        if (rewritten === null) continue; // env が空になった
        if (rewritten === undefined) {
          body.push(...lines.slice(item.start, item.end + 1));
          continue;
        }
        body.push(rewritten);
        continue;
      }
    }

    body.push(...lines.slice(item.start, item.end + 1));
  }

  const missing: string[] = [];
  if (!sawCommand) missing.push(`command = "npx"`);
  if (!sawArgs) missing.push(...buildArgsLines(packageSpec));
  return [...missing, ...body];
}
