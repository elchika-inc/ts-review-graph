import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(cliRoot, "dist/index.js");
const cliVersion = (
  JSON.parse(readFileSync(path.join(cliRoot, "package.json"), "utf-8")) as { version: string }
).version;
const packageSpec = `@elchika-inc/ts-review-graph-mcp-server@${cliVersion}`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createProject(): string {
  const root = path.join(os.tmpdir(), `ts-rg-codex-${randomUUID()}`);
  roots.push(root);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src/main.ts"), "export const main = true;\n");
  writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext" }, include: ["src"] })
  );
  return root;
}

function runInstall(root: string, extraArgs: string[] = []): string {
  return execFileSync(
    process.execPath,
    [cliPath, "install", "--tsconfig", "tsconfig.json", ...extraArgs],
    { cwd: root, encoding: "utf8" }
  );
}

function readCodexConfig(root: string): string {
  return readFileSync(path.join(root, ".codex/config.toml"), "utf-8");
}

describe("install が生成する .codex/config.toml", () => {
  it("新規 project で version 固定・env なしのエントリを作り、2回目で重複しない", () => {
    const root = createProject();

    const firstOutput = runInstall(root);
    const first = readCodexConfig(root);
    expect(firstOutput).toContain(".codex/config.toml");
    expect(first).toBe(
      `[mcp_servers.ts-review-graph]\ncommand = "npx"\nargs = [\n    "-y",\n    "${packageSpec}",\n]\n`
    );
    expect(first).not.toContain("env");

    runInstall(root);
    const second = readCodexConfig(root);
    expect(second).toBe(first);
    expect(second.split("[mcp_servers.ts-review-graph]").length - 1).toBe(1);
  });

  it("既存の他エントリを壊さず、古い絶対パスの env を除去する", () => {
    const root = createProject();
    mkdirSync(path.join(root, ".codex"), { recursive: true });
    writeFileSync(
      path.join(root, ".codex/config.toml"),
      `# project config
[mcp_servers.other]
command = "other-bin"
args = ["--serve"]

[mcp_servers.ts-review-graph]
command = "npx"
args = [
    "-y",
    "@elchika-inc/ts-review-graph-mcp-server@0.0.1",
]
env = { TS_REVIEW_GRAPH_DB = "/old/absolute/path/.ts-review-graph/graph.db" }
`
    );

    runInstall(root);
    const updated = readCodexConfig(root);

    expect(updated).toContain("# project config");
    expect(updated).toContain("[mcp_servers.other]");
    expect(updated).toContain(`command = "other-bin"`);
    expect(updated).toContain(`args = ["--serve"]`);
    expect(updated).toContain(`    "${packageSpec}",`);
    expect(updated).not.toContain("@0.0.1");
    expect(updated).not.toContain("TS_REVIEW_GRAPH_DB");
    expect(updated).not.toContain("/old/absolute/path");
  });

  it("custom --db では Codex が既定 DB を見る旨を毎回警告する", () => {
    const root = createProject();
    const warning = "Codex 側は既定の .ts-review-graph/graph.db を参照します";

    // 「Codex 側だけ別 DB を見る」状態は install を繰り返しても続くので、
    // 書き換えの有無に関わらず警告が出続ける必要がある。
    expect(runInstall(root, ["--db", "custom/graph.db"])).toContain(warning);
    expect(runInstall(root, ["--db", "custom/graph.db"])).toContain(warning);
    expect(readCodexConfig(root)).not.toContain("env");
  });

  it("既定 DB では余計な警告を出さない", () => {
    const root = createProject();
    expect(runInstall(root)).not.toContain("既定の .ts-review-graph/graph.db を参照します");
  });

  it("解釈できない .codex/config.toml では設定ファイル群を書かずに失敗する", () => {
    const root = createProject();
    mkdirSync(path.join(root, ".codex"), { recursive: true });
    const broken = `[mcp_servers]\nts-review-graph = { command = "npx" }\n`;
    writeFileSync(path.join(root, ".codex/config.toml"), broken);

    let status = 0;
    let stderr = "";
    try {
      runInstall(root);
    } catch (err) {
      const failure = err as { status?: number; stderr?: string };
      status = failure.status ?? 0;
      stderr = failure.stderr ?? "";
    }

    expect(status).toBe(1);
    expect(stderr).toContain(".codex/config.toml を安全に更新できません");
    // 中止時点までに走るのは既存の冪等な準備手順（.ts-review-graph/ignore 作成・.gitignore 追記）
    // のみで、設定ファイル群は一切書かれない
    expect(readCodexConfig(root)).toBe(broken);
    expect(() => readFileSync(path.join(root, ".mcp.json"), "utf-8")).toThrow();
    expect(() => readFileSync(path.join(root, ".ts-review-graph/config.json"), "utf-8")).toThrow();
  });
});
