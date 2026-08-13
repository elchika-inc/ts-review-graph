import { describe, expect, it } from "vitest";
import { updateCodexConfig, CodexConfigParseError } from "../src/codex-config.js";

const SPEC = "@elchika-inc/ts-review-graph-mcp-server@9.9.9";

const canonical = `[mcp_servers.ts-review-graph]
command = "npx"
args = [
    "-y",
    "${SPEC}",
]
`;

describe("updateCodexConfig — 新規作成", () => {
  it("空ファイルには version 固定・env なしのエントリだけを書く", () => {
    const result = updateCodexConfig("", SPEC);
    expect(result).toEqual({ content: canonical, changed: true, skippedReason: null });
    expect(result.content).not.toContain("env");
  });

  it("既存の他セクションを保ったまま末尾へ追記する", () => {
    const current = `[mcp_servers.other]\ncommand = "other-bin"\nargs = ["--serve"]\n`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.changed).toBe(true);
    expect(result.content).toBe(`${current}\n${canonical}`);
  });
});

describe("updateCodexConfig — 冪等性", () => {
  it("2回目は内容を変えない", () => {
    const first = updateCodexConfig("", SPEC).content;
    const second = updateCodexConfig(first, SPEC);

    expect(second.changed).toBe(false);
    expect(second.content).toBe(first);
  });

  it("エントリが重複しない", () => {
    let content = "";
    for (let i = 0; i < 3; i++) content = updateCodexConfig(content, SPEC).content;

    const occurrences = content.split("[mcp_servers.ts-review-graph]").length - 1;
    expect(occurrences).toBe(1);
  });

  it("version だけが違う既存エントリは args を更新する", () => {
    const old = canonical.replace(SPEC, "@elchika-inc/ts-review-graph-mcp-server@0.0.1");
    const result = updateCodexConfig(old, SPEC);

    expect(result.changed).toBe(true);
    expect(result.content).toBe(canonical);
  });
});

describe("updateCodexConfig — 既存エントリの尊重", () => {
  it("利用者が変えた command は上書きしない（更新するのは args だけ）", () => {
    const current = `[mcp_servers.ts-review-graph]
command = "bunx"
args = ["-y", "@elchika-inc/ts-review-graph-mcp-server@0.0.1"]
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).toContain(`command = "bunx"`);
    expect(result.content).not.toContain(`command = "npx"`);
    expect(result.content).toContain(`"${SPEC}"`);
  });

  it("command が無いエントリには npx を補う", () => {
    const current = `[mcp_servers.ts-review-graph]\nargs = ["-y", "@elchika-inc/ts-review-graph-mcp-server@0.0.1"]\n`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).toContain(`command = "npx"`);
  });

  it("version 未固定の package 指定にも version を入れる", () => {
    const current = `[mcp_servers.ts-review-graph]
command = "npx"
args = ["-y", "@elchika-inc/ts-review-graph-mcp-server", "--log-level", "debug"]
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).toContain(`args = ["-y", "${SPEC}", "--log-level", "debug"]`);
  });

  it("利用者が args に足した引数を消さない（version 要素だけ差し替える）", () => {
    const current = `[mcp_servers.ts-review-graph]
command = "npx"
args = ["-y", "@elchika-inc/ts-review-graph-mcp-server@0.0.1", "--log-level", "debug"]
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).toContain(
      `args = ["-y", "${SPEC}", "--log-level", "debug"]`
    );
    expect(result.content).not.toContain("@0.0.1");
  });

  it("複数行 args でも他要素と整形を保つ", () => {
    const current = `[mcp_servers.ts-review-graph]
command = "npx"
args = [
    "-y",
    "@elchika-inc/ts-review-graph-mcp-server@0.0.1",
    "--verbose",
]
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).toContain(`    "${SPEC}",`);
    expect(result.content).toContain(`    "--verbose",`);
  });

  it("名前を含むだけの引数を package spec と取り違えない", () => {
    // 一致判定を緩めると、パスやフラグ値に ts-review-graph を含む引数が
    // package spec で上書きされて黙って消える。
    const current = `[mcp_servers.ts-review-graph]
command = "npx"
args = ["-y", "@elchika-inc/ts-review-graph-mcp-server@0.0.1", "--config", "/home/me/ts-review-graph.json", "@elchika-inc/ts-review-graph@0.5.4"]
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).toContain(`"--config", "/home/me/ts-review-graph.json"`);
    // CLI package (mcp-server ではない) も置換対象にしない
    expect(result.content).toContain(`"@elchika-inc/ts-review-graph@0.5.4"`);
    expect(result.content).toContain(`"${SPEC}"`);
    expect(result.content).not.toContain("@0.0.1");
  });

  // 「解釈できない構造 → 全体中止(throw)」と「解釈できるが書き換えられないエントリ →
  // 触らず続行」を分ける。後者を throw にすると、独自の起動方法を設定している利用者は
  // install を完走できず .mcp.json の更新経路まで恒久的に塞がれる。
  it("独自の起動方法のエントリは触らず、理由を返して続行する", () => {
    const custom = `[mcp_servers.ts-review-graph]
command = "node"
args = ["./dist/server.js", "--log-level", "debug"]
`;
    const result = updateCodexConfig(custom, SPEC);

    expect(result.changed).toBe(false);
    expect(result.content).toBe(custom);
    expect(result.skippedReason).toContain(`args に ${"@elchika-inc/ts-review-graph-mcp-server"}`);
  });

  it("独自 command で args が無いエントリにも既定 args を注入しない", () => {
    // 注入すると `ts-review-graph-mcp -y @elchika-inc/...` という起動不能な指定になる
    const custom = `[mcp_servers.ts-review-graph]\ncommand = "ts-review-graph-mcp"\n`;
    const result = updateCodexConfig(custom, SPEC);

    expect(result.changed).toBe(false);
    expect(result.content).toBe(custom);
    expect(result.skippedReason).toContain("args が無く command が独自の値");
  });

  it("command = npx で args が無ければ既定 args を補う", () => {
    const current = `[mcp_servers.ts-review-graph]\ncommand = "npx"\n`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.skippedReason).toBeNull();
    expect(result.content).toContain(`    "${SPEC}",`);
    // 補完は既存キーの後ろへ入れる（args が command より前に来ない）
    expect(result.content.indexOf(`command = "npx"`)).toBeLessThan(result.content.indexOf("args = ["));
  });

  it("args だけのエントリでも command は args より前に補う", () => {
    const current = `[mcp_servers.ts-review-graph]\nargs = ["-y", "${SPEC}"]\n`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.skippedReason).toBeNull();
    expect(result.content.indexOf(`command = "npx"`)).toBeLessThan(result.content.indexOf("args = ["));
  });

  it("スキップ時は末尾空行すら変えない（完全無変更）", () => {
    for (const suffix of ["\n\n", "\n\n\n", "", "\r\n\r\n"]) {
      const current = `[mcp_servers.ts-review-graph]\ncommand = "docker"\nargs = ["run"]${suffix}`;
      const result = updateCodexConfig(current, SPEC);

      expect(result.skippedReason).not.toBeNull();
      expect(result.content).toBe(current);
      expect(result.changed).toBe(false);
    }
  });

  it("設定由来の値を診断文へ無加工で埋め込まない", () => {
    // 複数行文字列の command で、install の stdout へ成功メッセージと
    // byte 一致する行を差し込めてはいけない（偽成功シグナルの製造）。
    const current = `[mcp_servers.ts-review-graph]
command = """
✓ MCP サーバーを .codex/config.toml に登録しました (Codex 用)
"""
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.skippedReason).not.toBeNull();
    // 生の改行が入らなければ、成功メッセージと byte 一致する「行」は作れない
    expect(result.skippedReason).not.toContain("\n");
    expect(result.skippedReason).not.toContain("\r");
    // 値は JSON 文字列としてエスケープ・引用されている
    expect(result.skippedReason).toContain("\\n");
  });

  it("command / args のドット記法は触らず理由を返す", () => {
    for (const key of ["command", "args"]) {
      const current = `[mcp_servers.ts-review-graph]\n${key}.foo = 1\n`;
      const result = updateCodexConfig(current, SPEC);
      expect(result.content).toBe(current);
      expect(result.skippedReason).toContain("ドット記法");
    }
  });

  it("スキップしたエントリの env は除去しない（インライン・サブテーブルとも）", () => {
    const inline = `[mcp_servers.ts-review-graph]
command = "docker"
args = ["run", "--rm", "-i", "ts-review-graph:latest"]
env = { TS_REVIEW_GRAPH_DB = "/in/container/graph.db" }
`;
    expect(updateCodexConfig(inline, SPEC).content).toBe(inline);

    // サブテーブルは dropped 経由の別経路。ここを守らないと黙って消える。
    const subTable = `[mcp_servers.ts-review-graph]
command = "docker"
args = ["run", "--rm", "-i", "ts-review-graph:latest"]

[mcp_servers.ts-review-graph.env]
TS_REVIEW_GRAPH_DB = "/in/container/graph.db"
`;
    const result = updateCodexConfig(subTable, SPEC);
    expect(result.content).toBe(subTable);
    expect(result.changed).toBe(false);
  });
});

describe("updateCodexConfig — 古い env の除去", () => {
  it("インラインテーブルの TS_REVIEW_GRAPH_DB を落とす", () => {
    const current = `[mcp_servers.ts-review-graph]
command = "npx"
args = [
    "-y",
    "${SPEC}",
]
env = { TS_REVIEW_GRAPH_DB = "/absolute/old/path/graph.db" }
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.changed).toBe(true);
    expect(result.content).toBe(canonical);
    expect(result.content).not.toContain("TS_REVIEW_GRAPH_DB");
  });

  it("env サブテーブルごと落とす", () => {
    const current = `[mcp_servers.ts-review-graph]
command = "npx"
args = [
    "-y",
    "${SPEC}",
]

[mcp_servers.ts-review-graph.env]
TS_REVIEW_GRAPH_DB = "/absolute/old/path/graph.db"

[mcp_servers.other]
command = "other-bin"
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).not.toContain("TS_REVIEW_GRAPH_DB");
    expect(result.content).not.toContain("[mcp_servers.ts-review-graph.env]");
    expect(result.content).toContain("[mcp_servers.other]");
    expect(result.content).toContain(`command = "other-bin"`);
  });

  it("自分の env の他のキーは残し、TS_REVIEW_GRAPH_DB だけ落とす", () => {
    const current = `[mcp_servers.ts-review-graph]
command = "npx"
args = [
    "-y",
    "${SPEC}",
]
env = { TS_REVIEW_GRAPH_DB = "/old/graph.db", NODE_OPTIONS = "--max-old-space-size=4096" }
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).not.toContain("TS_REVIEW_GRAPH_DB");
    expect(result.content).toContain(`env = { NODE_OPTIONS = "--max-old-space-size=4096" }`);
  });

  it("前方一致の似たキーを巻き込まない（除去は厳密一致のみ）", () => {
    // 対照キーは TS_REVIEW_GRAPH_DB の真の前方一致拡張であること。
    // 語幹が同じだけのキー（..._LOG 等）では厳密一致→前方一致の緩和を検出できない。
    const inline = `[mcp_servers.ts-review-graph]
command = "npx"
args = ["-y", "${SPEC}"]
env = { TS_REVIEW_GRAPH_DB = "/x", TS_REVIEW_GRAPH_DB_PATH = "/keep" }
`;
    const inlineResult = updateCodexConfig(inline, SPEC);
    expect(inlineResult.content).toContain(`TS_REVIEW_GRAPH_DB_PATH = "/keep"`);
    expect(inlineResult.content).not.toContain(`TS_REVIEW_GRAPH_DB = "/x"`);

    const subTable = `[mcp_servers.ts-review-graph]
command = "npx"
args = ["-y", "${SPEC}"]

[mcp_servers.ts-review-graph.env]
TS_REVIEW_GRAPH_DB = "/x"
TS_REVIEW_GRAPH_DB_PATH = "/keep"
`;
    const subResult = updateCodexConfig(subTable, SPEC);
    expect(subResult.content).toContain(`TS_REVIEW_GRAPH_DB_PATH = "/keep"`);
    expect(subResult.content).not.toContain(`TS_REVIEW_GRAPH_DB = "/x"`);
  });

  it("env 以外のサブテーブルは刈らない", () => {
    // キーを持つ extra と、コメントだけの placeholder の両方を見る。
    // 後者は「見出しごと落とす」判定に掛かるため、env 限定ガードが無いと消える。
    const current = `[mcp_servers.ts-review-graph]
command = "npx"
args = ["-y", "${SPEC}"]

[mcp_servers.ts-review-graph.extra]
retries = 3

[mcp_servers.ts-review-graph.placeholder]
# あとで書く
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).toContain("[mcp_servers.ts-review-graph.extra]");
    expect(result.content).toContain("retries = 3");
    expect(result.content).toContain("[mcp_servers.ts-review-graph.placeholder]");
  });

  it("env の行末コメントとインデントを保つ", () => {
    const current = `[mcp_servers.ts-review-graph]
command = "npx"
args = ["-y", "${SPEC}"]
  env = { TS_REVIEW_GRAPH_DB = "/x", OTHER = "y" } # 本番だけ上書き
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).toContain(`  env = { OTHER = "y" } # 本番だけ上書き`);
    expect(result.content).not.toContain("TS_REVIEW_GRAPH_DB");
  });

  it("インラインテーブルでない env は解釈せずそのまま残す", () => {
    // `env = "a{b"` は妥当な TOML。文字列内の波括弧を値の開始と誤認して
    // 「文字列が閉じられていません」で install 全体を止めてはいけない。
    for (const value of [`"a{b"`, `["a{b"]`, `"{}"`, `'x{y'`]) {
      const current = `[mcp_servers.ts-review-graph]\ncommand = "npx"\nargs = ["-y", "${SPEC}"]\nenv = ${value}\n`;
      const result = updateCodexConfig(current, SPEC);
      expect(result.content).toContain(`env = ${value}`);
    }
  });

  it("env サブテーブルでは該当行だけ落とし、他キーと見出しを残す", () => {
    const current = `[mcp_servers.ts-review-graph]
command = "npx"
args = ["-y", "${SPEC}"]

[mcp_servers.ts-review-graph.env]
TS_REVIEW_GRAPH_DB = "/old/graph.db"
NODE_OPTIONS = "--trace-warnings"
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).not.toContain("TS_REVIEW_GRAPH_DB");
    expect(result.content).toContain("[mcp_servers.ts-review-graph.env]");
    expect(result.content).toContain(`NODE_OPTIONS = "--trace-warnings"`);
  });

  it("env.TS_REVIEW_GRAPH_DB のドット記法も落とす", () => {
    const current = `[mcp_servers.ts-review-graph]
command = "npx"
args = ["-y", "${SPEC}"]
env.TS_REVIEW_GRAPH_DB = "/old/graph.db"
env.NODE_OPTIONS = "--trace-warnings"
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).not.toContain("TS_REVIEW_GRAPH_DB");
    expect(result.content).toContain(`env.NODE_OPTIONS = "--trace-warnings"`);
  });

  it("env サブテーブル削除が次セクションの前置コメントを巻き込まない", () => {
    const current = `[mcp_servers.ts-review-graph]
command = "npx"
args = ["-y", "${SPEC}"]

[mcp_servers.ts-review-graph.env]
TS_REVIEW_GRAPH_DB = "/old/graph.db"

# 次のサーバーの説明
# 2行目
[mcp_servers.other]
command = "other-bin"
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).toContain("# 次のサーバーの説明");
    expect(result.content).toContain("# 2行目");
    expect(result.content).toContain("[mcp_servers.other]");
    expect(result.content).not.toContain("TS_REVIEW_GRAPH_DB");
  });

  it("他エントリの env には触れない", () => {
    const current = `[mcp_servers.other]
command = "other-bin"
env = { TS_REVIEW_GRAPH_DB = "/keep/me/graph.db" }
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).toContain(`env = { TS_REVIEW_GRAPH_DB = "/keep/me/graph.db" }`);
  });
});

describe("updateCodexConfig — 既存内容の保全", () => {
  it("前後のセクション・コメント・トップレベルキーを保つ", () => {
    const current = `# codex project config
trust_level = "trusted"

[mcp_servers.alpha]
command = "alpha-bin"
args = [
    "--flag",
]

[mcp_servers.ts-review-graph]
command = "npx"
args = ["-y", "@elchika-inc/ts-review-graph-mcp-server@0.0.1"]

[profiles.default]
model = "gpt-5"
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).toContain("# codex project config");
    expect(result.content).toContain(`trust_level = "trusted"`);
    expect(result.content).toContain("[mcp_servers.alpha]");
    expect(result.content).toContain(`command = "alpha-bin"`);
    expect(result.content).toContain("[profiles.default]");
    expect(result.content).toContain(`model = "gpt-5"`);
    expect(result.content).toContain(`"${SPEC}"`);
    expect(result.content).not.toContain("@0.0.1");
  });

  it("自分のセクションに利用者が足したキーは残す", () => {
    const current = `[mcp_servers.ts-review-graph]
command = "npx"
args = ["-y", "@elchika-inc/ts-review-graph-mcp-server@0.0.1"]
startup_timeout_ms = 30000
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).toContain("startup_timeout_ms = 30000");
    expect(result.content).toContain(`"${SPEC}"`);
  });

  it("BOM 付きファイルを解釈し、BOM を保ったまま更新する", () => {
    // Codex (toml-rs) は BOM 付きを正常にロードする。ここで throw すると
    // 利用者側は壊れていないのに install 全体が中止してしまう。
    const current = `﻿[mcp_servers.other]\ncommand = "other-bin"\n`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content.startsWith("﻿")).toBe(true);
    expect(result.content).toContain("[mcp_servers.other]");
    expect(result.content).toContain("[mcp_servers.ts-review-graph]");
    // BOM が本文へ紛れ込んでいないこと
    expect(result.content.slice(1)).not.toContain("﻿");
  });

  it("BOM 付きでも2回目は変更しない", () => {
    const first = updateCodexConfig(`﻿[mcp_servers.other]\ncommand = "x"\n`, SPEC).content;
    expect(updateCodexConfig(first, SPEC).changed).toBe(false);
  });

  it("CRLF のファイルを LF へ書き換えない", () => {
    const current = `[mcp_servers.other]\r\ncommand = "other-bin"\r\n`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).toContain(`[mcp_servers.other]\r\ncommand = "other-bin"\r\n`);
    expect(result.content).toContain(`[mcp_servers.ts-review-graph]\r\n`);
    expect(result.content).not.toMatch(/[^\r]\n/);
  });

  it("配列内の行頭 [ をテーブル見出しと誤認しない", () => {
    const current = `[mcp_servers.alpha]
matrix = [
["a", "b"],
["c", "d"],
]
command = "alpha-bin"
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content).toContain(`["a", "b"],`);
    expect(result.content).toContain(`command = "alpha-bin"`);
    expect(result.content).toContain("[mcp_servers.ts-review-graph]");
  });

  it("複数行文字列の中身を解釈しない", () => {
    const current = `[mcp_servers.alpha]
note = """
[mcp_servers.ts-review-graph]
"""
command = "alpha-bin"
`;
    const result = updateCodexConfig(current, SPEC);

    // 文字列の中の見出しは既存エントリとして扱わないので、末尾に本物が追記される
    expect(result.content).toContain(`note = """`);
    // 文字列内の1つ + 末尾に追記された本物の1つ = 2 出現
    expect(result.content.split("[mcp_servers.ts-review-graph]").length - 1).toBe(2);
    expect(result.content).toContain(`"${SPEC}"`);
  });

  it("エスケープを含む引用見出しも既存エントリとして認識する（重複追記しない）", () => {
    const current = `[mcp_servers."ts\\u002Dreview\\u002Dgraph"]
command = "npx"
args = ["-y", "@elchika-inc/ts-review-graph-mcp-server@0.0.1"]
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content.split("mcp_servers.").length - 1).toBe(1);
    expect(result.content).toContain(`"${SPEC}"`);
  });

  it("リテラル文字列の見出しも既存エントリとして認識する", () => {
    const current = `[mcp_servers.'ts-review-graph']
command = "npx"
args = ["-y", "@elchika-inc/ts-review-graph-mcp-server@0.0.1"]
`;
    const result = updateCodexConfig(current, SPEC);

    expect(result.content.split("[mcp_servers.").length - 1).toBe(1);
    expect(result.content).toContain(`"${SPEC}"`);
  });

  it("引用付きのテーブル見出しも既存エントリとして認識する", () => {
    const current = `[mcp_servers."ts-review-graph"]
command = "npx"
args = ["-y", "@elchika-inc/ts-review-graph-mcp-server@0.0.1"]
`;
    const result = updateCodexConfig(current, SPEC);

    const occurrences = result.content.split("mcp_servers.").length - 1;
    expect(occurrences).toBe(1);
    expect(result.content).toContain(`"${SPEC}"`);
  });
});

describe("updateCodexConfig — fail-closed", () => {
  it("値が閉じないファイルは throw する（呼び出し側は書き込まない）", () => {
    expect(() => updateCodexConfig(`[mcp_servers.alpha]\nargs = [\n"-y",\n`, SPEC)).toThrow(
      CodexConfigParseError
    );
  });

  it("閉じない文字列は throw する", () => {
    expect(() => updateCodexConfig(`[mcp_servers.alpha]\ncommand = "npx\n`, SPEC)).toThrow(
      CodexConfigParseError
    );
  });

  it("閉じないテーブル見出しは throw する", () => {
    expect(() => updateCodexConfig(`[mcp_servers.alpha\n`, SPEC)).toThrow(CodexConfigParseError);
  });

  // インラインテーブル/ドット記法は「読めているが in-place で書き換えられない」ケース。
  // 実 codex はこれらのファイルを正常にロードするので、全体中止にすると
  // 利用者は壊れていない設定のせいで install を完走できなくなる。
  // 末尾へ見出しを足すと TOML 仕様違反になるため、書かずにスキップする。
  it("インラインテーブル/ドット記法のエントリは書かずにスキップする", () => {
    const cases = [
      `[mcp_servers]\nts-review-graph = { command = "npx", args = ["-y"] }\n`,
      `mcp_servers.ts-review-graph.command = "npx"\n`,
      `mcp_servers = { other = { command = "x" } }\n`,
      `mcp_servers = {}\n`,
    ];
    for (const current of cases) {
      const result = updateCodexConfig(current, SPEC);
      expect(result.content).toBe(current);
      expect(result.changed).toBe(false);
      expect(result.skippedReason).toContain("インラインテーブル/ドット記法");
      // 末尾へ見出しを足していないこと（足すと invalid TOML になる）
      expect(result.content).not.toContain("[mcp_servers.ts-review-graph]");
    }
  });

  it("兄弟キー mcp_servers.other は throw しない（正当な記法を壊さない）", () => {
    const result = updateCodexConfig(`mcp_servers.other.command = "x"\n`, SPEC);
    expect(result.content).toContain(`mcp_servers.other.command = "x"`);
    expect(result.content).toContain("[mcp_servers.ts-review-graph]");
  });

  it("[mcp_servers] という見出し自体は throw しない", () => {
    const result = updateCodexConfig(`[mcp_servers]\nother = { command = "x" }\n`, SPEC);
    expect(result.content).toContain("[mcp_servers]");
    expect(result.content).toContain("[mcp_servers.ts-review-graph]");
  });

  it("エントリの重複定義は throw する", () => {
    expect(() => updateCodexConfig(`${canonical}\n${canonical}`, SPEC)).toThrow(
      CodexConfigParseError
    );
  });

  it("array of tables は throw する", () => {
    expect(() =>
      updateCodexConfig(`[[mcp_servers.ts-review-graph]]\ncommand = "npx"\n`, SPEC)
    ).toThrow(CodexConfigParseError);
  });
});
