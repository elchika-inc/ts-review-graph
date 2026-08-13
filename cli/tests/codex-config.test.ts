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
    expect(result).toEqual({ content: canonical, changed: true });
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

  it("args に自分の package spec が無ければ書き換えずに throw する", () => {
    // 既定 args で上書きすると、独自の起動方法を壊した設定へ黙って変えてしまう。
    // 例: command = "node" のまま `node -y @elchika-inc/...` になり起動不能。
    const custom = `[mcp_servers.ts-review-graph]
command = "node"
args = ["./dist/server.js", "--log-level", "debug"]
`;
    expect(() => updateCodexConfig(custom, SPEC)).toThrow(CodexConfigParseError);
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
    expect(result.content.trimEnd().endsWith(`]`)).toBe(true);
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

  it("インラインテーブル記法のエントリは throw する", () => {
    const current = `[mcp_servers]\nts-review-graph = { command = "npx", args = ["-y"] }\n`;
    expect(() => updateCodexConfig(current, SPEC)).toThrow(CodexConfigParseError);
  });

  it("ドット記法のエントリは throw する", () => {
    expect(() =>
      updateCodexConfig(`mcp_servers.ts-review-graph.command = "npx"\n`, SPEC)
    ).toThrow(CodexConfigParseError);
  });

  // 祖先側のインラインテーブル。見落とすと「インラインテーブルへ後からテーブル見出しを
  // 足す」TOML 仕様違反のファイルを書き出し、Codex が project 設定を丸ごと読めなくなる。
  it("mcp_servers 自体がインラインテーブルなら throw する（自エントリ不在でも）", () => {
    expect(() =>
      updateCodexConfig(`mcp_servers = { other = { command = "x" } }\n`, SPEC)
    ).toThrow(CodexConfigParseError);
  });

  it("空のインラインテーブル mcp_servers = {} でも throw する", () => {
    expect(() => updateCodexConfig(`mcp_servers = {}\n`, SPEC)).toThrow(CodexConfigParseError);
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
