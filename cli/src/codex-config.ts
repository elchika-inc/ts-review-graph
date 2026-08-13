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
  /**
   * 既存エントリを安全に更新できず、触れずに残した理由。
   *
   * 中止の粒度は2段に分ける。判定軸は「**ファイルを正しく読めたか**」:
   * - **読めない**（値/文字列が閉じない、括弧の対応が取れない、見出しを解釈できない、
   *   重複定義、`[[...]]`）→ `CodexConfigParseError`。何も書かない（fail-closed）
   * - **読めたが in-place で書き換えられない** → ここに理由を入れて続行。
   *   ファイルへ1バイトも書かないので常に安全であり、独自の起動方法（docker /
   *   node ラッパー等）や記法（インラインテーブル）を使う利用者の install を
   *   恒久的に塞がない。
   */
  skippedReason: string | null;
  /**
   * スキップした結果、ts-review-graph のエントリを**追加できなかった**か。
   *
   * true は「既存エントリが無い」ことの断定ではない——`mcp_servers` 自体が
   * インラインテーブルの場合は中身を解釈しないため、既にエントリがあるかどうかを
   * 判定できない。いずれにせよ「既存エントリの version を直せばよい」ではないので、
   * 案内を分ける必要がある。
   */
  entryNotAdded: boolean;
}

const SERVER_TABLE_PATH = ["mcp_servers", "ts-review-graph"] as const;

// 旧 version が .mcp.json から写した絶対パス。Codex 用エントリには env を書かない方針のため除去する。
// 利用者が置いた他の env キーには触れない。
const STALE_ENV_KEY = "TS_REVIEW_GRAPH_DB";

const MCP_PACKAGE_NAME = "@elchika-inc/ts-review-graph-mcp-server";

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

type MultilineDelimiter = '"""' | "'''";

interface ScanState {
  depth: number;
  multiline: MultilineDelimiter | null;
}

/**
 * 複数行文字列の終端位置（閉じ区切りの直後）を返す。見つからなければ null。
 *
 * TOML は閉じ区切りの直前に同じ引用符を1〜2個まで置ける（内容として扱われる）。
 * 最初に見つけた3連で切ると余った引用符が新しい文字列の開始と誤読され、
 * 妥当な TOML を「閉じられていません」と誤診断して install 全体を止めてしまう。
 * 基本文字列はエスケープを持つので、エスケープされた引用符も終端と誤認しない。
 */
function findMultilineEnd(
  text: string,
  from: number,
  delimiter: MultilineDelimiter
): number | null {
  const quote = delimiter[0]!;
  const escapable = delimiter === '"""';
  let i = from;
  while (i < text.length) {
    if (escapable && text[i] === "\\") {
      i += 2;
      continue;
    }
    if (!text.startsWith(delimiter, i)) {
      i++;
      continue;
    }
    let end = i + 3;
    let extra = 0;
    while (extra < 2 && text[end] === quote) {
      end++;
      extra++;
    }
    return end;
  }
  return null;
}
/** 1行を走査して括弧の深さと複数行文字列の状態を更新する。解釈できない行では throw する。 */
function scanLine(line: string, state: ScanState): void {
  let i = 0;
  if (state.multiline) {
    const end = findMultilineEnd(line, 0, state.multiline);
    if (end === null) return;
    i = end;
    state.multiline = null;
  }
  while (i < line.length) {
    const char = line[i]!;
    if (char === "#") return; // 文字列外の # は行コメント
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      const delimiter = line.startsWith('"""', i) ? '"""' : "'''";
      const end = findMultilineEnd(line, i + 3, delimiter);
      if (end === null) {
        state.multiline = delimiter;
        return;
      }
      i = end;
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
    const end = findMultilineEnd(text, i + 3, delimiter);
    if (end === null) throw new CodexConfigParseError("複数行文字列が閉じられていません");
    return end;
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
 * インラインテーブル値の中で重複しているキー名を返す（無ければ null）。
 * TOML としては不正な入力だが、素通しすると壊れた設定を書き戻してしまう。
 */
function findInlineTableDuplicateKey(raw: string): string | null {
  const keyPath = readKeyPath(raw, 0);
  if (!keyPath) return null;
  let cursor = skipWs(raw, keyPath.next);
  if (raw[cursor] !== "=") return null;
  cursor = skipWs(raw, cursor + 1);
  return findDuplicateInValue(raw, cursor);
}

/** 値がインラインテーブル・配列なら、その中の重複キーを探す。 */
function findDuplicateInValue(text: string, cursor: number): string | null {
  const open = text[cursor];
  if (open !== "{" && open !== "[") return null;

  const close = findMatchingBrace(text, cursor);
  if (close === null) return null;
  const body = text.slice(cursor + 1, close);

  if (open === "{") return findDuplicateInInlineBody(body);

  // 配列は要素ごとに見る（要素がインラインテーブルなら中も見る）
  for (const element of splitInlineTableEntries(body)) {
    const value = element.trim();
    if (value === "") continue;
    const nested = findDuplicateInValue(value, 0);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * インラインテーブルの中身を再帰的に走査し、重複キーを探す。
 * ネストしたインラインテーブル・配列要素まで見ないと、1段深いだけの
 * 重複を取りこぼして壊れた設定を書き戻してしまう。
 */
function findDuplicateInInlineBody(body: string): string | null {
  const seen = new Set<string>();
  for (const rawEntry of splitInlineTableEntries(body)) {
    // 複数行のインラインテーブルでは entry の先頭に改行が残る。
    // skipWs は改行を飛ばさないので、ここで落としておく。
    const entry = rawEntry.trim();
    if (entry === "") continue;

    const entryKey = readKeyPath(entry, 0);
    if (!entryKey) continue;
    const joined = entryKey.parts.join("\u0000");
    if (seen.has(joined)) return entryKey.parts.join(".");
    seen.add(joined);

    // 値がインラインテーブル / 配列なら中も見る
    let cursor = skipWs(entry, entryKey.next);
    if (entry[cursor] !== "=") continue;
    cursor = skipWs(entry, cursor + 1);
    const nested = findDuplicateInValue(entry, cursor);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * `args = [...]` の中の ts-review-graph package spec 要素だけを差し替える。
 * 配列ごと置き換えると利用者が足した引数（`--log-level debug` など）が黙って消えるため、
 * 該当の文字列トークンだけを in-place で置換して他の要素と整形を保つ。
 * 該当要素が無ければ null を返し、呼び出し側が既定の args を書く。
 */
function replacePackageSpecInArgs(raw: string, packageSpec: string): string | null {
  const keyPath = readKeyPath(raw, 0);
  if (!keyPath) return null;
  let cursor = skipWs(raw, keyPath.next);
  if (raw[cursor] !== "=") return null;
  cursor = skipWs(raw, cursor + 1);
  if (raw[cursor] !== "[") return null;

  const close = findMatchingBrace(raw, cursor);
  if (close === null) return null;

  const spans: { start: number; end: number }[] = [];
  let i = cursor + 1;
  while (i < close) {
    const char = raw[i];
    if (char === '"' || char === "'") {
      const next = skipAtomic(raw, i);
      if (next === null) {
        i++;
        continue;
      }
      // version 固定済み (`name@x.y.z`) と未固定 (`name`) の両方を対象にする。
      // 未固定を拾わないと、version を固定してあげられないまま素通りする。
      const token = raw.slice(i + 1, next - 1);
      if (token === MCP_PACKAGE_NAME || token.startsWith(`${MCP_PACKAGE_NAME}@`)) {
        spans.push({ start: i, end: next });
      }
      i = next;
      continue;
    }
    const skipped = skipAtomic(raw, i);
    i = skipped === null ? i + 1 : skipped;
  }

  if (spans.length === 0) return null;

  let out = raw;
  for (const span of spans.reverse()) {
    out = `${out.slice(0, span.start)}"${packageSpec}"${out.slice(span.end)}`;
  }
  return out;
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
  if (!keyPath) throw new CodexConfigParseError(`テーブル見出しを解釈できません: ${describeValue(line.trim())}`);

  i = skipWs(line, keyPath.next);
  const closing = arrayOfTables ? "]]" : "]";
  if (!line.startsWith(closing, i)) {
    throw new CodexConfigParseError(`テーブル見出しが閉じられていません: ${describeValue(line.trim())}`);
  }
  i = skipWs(line, i + closing.length);
  if (i < line.length && line[i] !== "#") {
    throw new CodexConfigParseError(`テーブル見出しの後に余分な記述があります: ${describeValue(line.trim())}`);
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
      throw new CodexConfigParseError(`キーと値の行を解釈できません: ${describeValue(trimmed)}`);
    }

    const state: ScanState = { depth: 0, multiline: null };
    let end = i;
    for (;;) {
      scanLine(lines[end]!, state);
      if (state.depth === 0 && state.multiline === null) break;
      end++;
      if (end >= lines.length) {
        throw new CodexConfigParseError(`値が閉じられないままファイルが終わっています: ${describeValue(trimmed)}`);
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
  let inlineSkipReason: string | null = null;
  const subTableIndexes: number[] = [];
  // 自エントリ配下のキーパス。重複はファイルを正しく読めていない証拠なので中止する。
  const ownKeyPaths = new Set<string>();

  for (const [index, item] of items.entries()) {
    if (item.kind === "header") {
      if (startsWithPath(item.parts, SERVER_TABLE_PATH)) {
        if (item.arrayOfTables) {
          throw new CodexConfigParseError(
            "[[mcp_servers.ts-review-graph]] (array of tables) は自動更新できません"
          );
        }
        // サブテーブル見出しもキーと同じ名前空間を占める。重複を見逃すと
        // 壊れた設定を書き戻して「登録しました」と報告してしまう。
        const headerPath = item.parts.join("\u0000");
        if (ownKeyPaths.has(headerPath)) {
          throw new CodexConfigParseError(
            `${describeTablePath(item.parts)} が複数回定義されています`
          );
        }
        ownKeyPaths.add(headerPath);

        if (samePath(item.parts, SERVER_TABLE_PATH)) {
          sectionIndex = index;
        } else if (
          startsWithPath(item.parts, [...SERVER_TABLE_PATH, "command"]) ||
          startsWithPath(item.parts, [...SERVER_TABLE_PATH, "args"])
        ) {
          // command / args をサブテーブルとして定義している。ドット記法と等価だが、
          // 見逃すと rewriteSectionBody が command/args を補い、妥当な TOML を
          // 壊れた TOML へ変えてしまう（しかも成功と報告する）。
          // 分岐条件が保証する位置を使う。at(-1) だと prefix 一致で拾った
          // 第4要素以降（利用者が名付けたキー）が素で診断文へ入り、
          // 案内するキー名も command/args でなくなる。
          const subTableKey = item.parts[SERVER_TABLE_PATH.length]!;
          inlineSkipReason ??= `${subTableKey} がサブテーブル（${describeTablePath(item.parts)}）として定義されています`;
          subTableIndexes.push(index);
        } else {
          subTableIndexes.push(index);
        }
      }
      currentTable = item.parts;
      continue;
    }

    if (item.kind !== "key") continue;

    // 自分のセクション（およびその子テーブル）の外側から
    // mcp_servers.ts-review-graph を値として定義している記法は in-place で更新できない。
    // 判定は双方向に行う必要がある:
    //   - キーが対象パスの子孫  … [mcp_servers] + `ts-review-graph = { ... }`
    //   - キーが対象パスの祖先  … ルートの `mcp_servers = { ... }`
    // 後者を見落として末尾へテーブル見出しを足すと、インラインテーブルへ後から
    // キーを足す TOML 仕様違反のファイルになり、Codex が project 設定を丸ごと読めなくなる。
    // 読めてはいるので中止ではなくスキップに倒す——書かなければ壊れない。
    if (startsWithPath(currentTable, SERVER_TABLE_PATH)) {
      // 自エントリ配下のキー重複はスキップ判定より前にここで倒す。
      // 後段（rewriteSectionBody）へ置くと、スキップ判定に吸われて到達しない組み合わせが出る。
      // env のように rewriteSectionBody が見ないキーも、ここなら漏れなく拾える。
      const keyPath = [...currentTable, ...item.parts].join("\u0000");
      if (ownKeyPaths.has(keyPath)) {
        throw new CodexConfigParseError(
          `${describeTablePath(currentTable)} で ${describeValue(item.parts.join("."))} が重複定義されています`
        );
      }
      ownKeyPaths.add(keyPath);

      // インラインテーブルの中のキー重複も見る。見逃すと壊れた設定を
      // そのまま書き戻して「登録しました」と報告してしまう。
      const duplicated = findInlineTableDuplicateKey(
        lines.slice(item.start, item.end + 1).join("\n")
      );
      if (duplicated !== null) {
        throw new CodexConfigParseError(
          `${describeTablePath(currentTable)} の ${describeValue(item.parts.join("."))} 内で ` +
            `${describeValue(duplicated)} が重複定義されています`
        );
      }
      continue;
    }
    const absolute = [...currentTable, ...item.parts];
    if (
      startsWithPath(absolute, SERVER_TABLE_PATH) ||
      startsWithPath(SERVER_TABLE_PATH, absolute)
    ) {
      inlineSkipReason ??= `${describeValue(absolute.join("."))} が値（インラインテーブル/ドット記法）として定義されています`;
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

  // 既存エントリを安全に更新できないなら、そのエントリは丸ごと元のまま残す。
  // env の除去も行わない——独自の起動方法では env が意味を持ちうる。
  const sectionBodyEnd = sectionIndex === -1 ? -1 : nextHeaderIndex(items, sectionIndex);
  const skippedReason =
    inlineSkipReason ??
    (sectionIndex === -1
      ? null
      : findSkipReason(items, lines, sectionIndex + 1, sectionBodyEnd, packageSpec));

  // スキップ時はファイルへ1バイトも書かない。末尾空行の正規化すら行わないことで
  // 「skippedReason を先に見よ」という暗黙の契約を戻り値の構造で担保する。
  if (skippedReason !== null) {
    return {
      content: current,
      changed: false,
      skippedReason,
      entryNotAdded: sectionIndex === -1,
    };
  }

  const output: string[] = [];
  for (const [index, item] of items.entries()) {
    if (dropped.has(index)) continue;

    if (index === sectionIndex) {
      output.push(...lines.slice(item.start, item.end + 1));
      output.push(...rewriteSectionBody(items, lines, index + 1, sectionBodyEnd, dropped, packageSpec));
      continue;
    }
    if (sectionIndex !== -1 && index > sectionIndex && index < sectionBodyEnd) {
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
  return { content, changed: content !== current, skippedReason, entryNotAdded: false };
}

function nextHeaderIndex(items: Item[], from: number): number {
  for (let i = from + 1; i < items.length; i++) {
    if (items[i]!.kind === "header") return i;
  }
  return items.length;
}

/** `command = "npx"` の値を取り出す。文字列以外・解釈不能なら null。 */
function readCommandValue(raw: string): string | null {
  const keyPath = readKeyPath(raw, 0);
  if (!keyPath) return null;
  let cursor = skipWs(raw, keyPath.next);
  if (raw[cursor] !== "=") return null;
  cursor = skipWs(raw, cursor + 1);
  const quote = raw[cursor];
  if (quote !== '"' && quote !== "'") return null;
  const close = skipAtomic(raw, cursor);
  if (close === null) return null;
  return raw.slice(cursor + 1, close - 1);
}

/**
 * 既存エントリを安全に更新できない理由を返す（無ければ null）。
 *
 * ここで返るのは「解釈はできるが、どう書き換えるべきか推測できない」ケースだけ。
 * 呼び出し側はエントリを触らずに警告する——独自の起動方法を設定している利用者の
 * install を恒久的に塞がないため、全体中止（throw）とは区別する。
 */
function findSkipReason(
  items: Item[],
  lines: string[],
  start: number,
  end: number,
  packageSpec: string
): string | null {
  let commandValue: string | null = null;
  let hasCommand = false;
  let argsItem: Item | null = null;

  for (let index = start; index < end; index++) {
    const item = items[index]!;
    if (item.kind !== "key") continue;
    const [head, ...rest] = item.parts;
    if (head !== "command" && head !== "args") continue;

    // `command.foo` / `args.foo` は command/args をテーブルとして扱う記法。
    // 補完した `command = "npx"` / `args = [...]` と衝突して invalid TOML を生む。
    if (rest.length > 0) {
      return `${head} がドット記法（${describeValue(item.parts.join("."))}）で定義されています`;
    }
    if (head === "command") {
      hasCommand = true;
      commandValue = readCommandValue(lines.slice(item.start, item.end + 1).join("\n"));
    } else {
      argsItem = item;
    }
  }

  if (argsItem) {
    const raw = lines.slice(argsItem.start, argsItem.end + 1).join("\n");
    if (replacePackageSpecInArgs(raw, packageSpec) === null) {
      return `args に ${MCP_PACKAGE_NAME} の指定がありません`;
    }
    return null;
  }

  // args 不在で command が独自値なら、既定 args を補うと
  // `<独自 command> -y @elchika-inc/...` という起動不能な組み合わせになる。
  if (hasCommand && commandValue !== "npx") {
    return `args が無く command が独自の値（${describeValue(commandValue)}）です`;
  }
  return null;
}

/**
 * テーブル見出しのパスを診断文へ埋め込む形に整える。
 * キー名は設定ファイル由来なので、`.` で連結しただけでは制御文字を持ち込める。
 */
function describeTablePath(parts: readonly string[]): string {
  return describeValue(parts.join("."));
}

/**
 * 設定ファイル由来の文字列（値・キー名とも）を診断文へ埋め込む形に整える。
 *
 * 無加工で埋め込むと、改行を含む `command` の値やキー名で install の stdout へ
 * 成功メッセージと byte 一致する行を差し込める（偽成功シグナルの製造）。
 * 設定ファイル由来の文字列を診断文へ入れる箇所は、すべてここを通すこと。
 */
function describeValue(value: string | null): string {
  if (value === null) return "解釈不能";
  const encoded = JSON.stringify(value);
  if (encoded.length <= 80) return encoded;
  // コードポイント単位で切る。UTF-16 単位だとサロゲートペアを割って U+FFFD になる。
  return `${Array.from(encoded).slice(0, 79).join("")}…`;
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
  let lastContentIndex = -1;

  for (let index = start; index < end; index++) {
    if (dropped.has(index)) continue;
    const item = items[index]!;

    if (item.kind === "key") {
      const [head, ...rest] = item.parts;
      // 重複キー・ドット記法・args の指定なしは、いずれも updateCodexConfig の走査と
      // findSkipReason が先に倒している（ゲートは1箇所）。ここは正常系だけを扱う。
      if (head === "command" && rest.length === 0) {
        sawCommand = true;
        // 利用者が変えた command は保持する（更新するのは args の version だけ）
        body.push(...lines.slice(item.start, item.end + 1));
        lastContentIndex = body.length;
        continue;
      }
      if (head === "args" && rest.length === 0) {
        sawArgs = true;
        const raw = lines.slice(item.start, item.end + 1).join("\n");
        const replaced = replacePackageSpecInArgs(raw, packageSpec);
        if (replaced === null) {
          throw new CodexConfigParseError(
            `[mcp_servers.ts-review-graph] の args に ${MCP_PACKAGE_NAME} の指定がありません`
          );
        }
        body.push(...replaced.split("\n"));
        lastContentIndex = body.length;
        continue;
      }
      if (head === "env") {
        // 古い TS_REVIEW_GRAPH_DB だけを除去し、利用者が置いた他の env キーは残す
        if (rest.length > 0) {
          if (rest.length === 1 && rest[0] === STALE_ENV_KEY) continue; // env.TS_REVIEW_GRAPH_DB
          body.push(...lines.slice(item.start, item.end + 1));
          lastContentIndex = body.length;
          continue;
        }
        const rewritten = removeStaleEnvKey(lines.slice(item.start, item.end + 1).join("\n"));
        if (rewritten === null) continue; // env が空になった
        body.push(
          ...(rewritten === undefined ? lines.slice(item.start, item.end + 1) : [rewritten])
        );
        lastContentIndex = body.length;
        continue;
      }
    }

    body.push(...lines.slice(item.start, item.end + 1));
    if (item.kind === "key") lastContentIndex = body.length;
  }

  if (sawCommand && sawArgs) return body;

  // args は既存キーの直後へ、command は必ず先頭へ入れる。
  // まとめて片側へ寄せると、command のみ／args のみのどちらかで順序が逆転する。
  const result = [...body];
  if (!sawArgs) {
    result.splice(lastContentIndex === -1 ? 0 : lastContentIndex, 0, ...buildArgsLines(packageSpec));
  }
  if (!sawCommand) result.unshift(`command = "npx"`);
  return result;
}
