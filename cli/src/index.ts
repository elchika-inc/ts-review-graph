#!/usr/bin/env node
import { Command } from "commander";
import { checkGraphHealth, openDb, buildFullGraph, updateFile, toProjectRelative } from "@elchika-inc/ts-review-graph-core";
import {
  mkdirSync,
  existsSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMcpServerEntry } from "./mcp-entry.js";
import {
  formatNpxAbiMismatchGuidance,
  updateGraphGitignore,
} from "./install-support.js";

const _pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
const _version = (JSON.parse(readFileSync(_pkgPath, "utf-8")) as { version: string }).version;

const CONFIG_FILE_NAME = ".ts-review-graph/config.json";

interface TsReviewGraphConfig {
  tsconfigs: string[];
}

function readConfig(projectRoot: string): TsReviewGraphConfig | null {
  const configPath = path.join(projectRoot, CONFIG_FILE_NAME);
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as TsReviewGraphConfig;
  } catch (err) {
    console.warn(`⚠ config.json の読み込みに失敗しました: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function writeConfig(projectRoot: string, config: TsReviewGraphConfig): void {
  const configPath = path.join(projectRoot, CONFIG_FILE_NAME);
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

const program = new Command();
program.name("ts-review-graph").version(_version);

// --- install ---
program
  .command("install")
  .description("プロジェクトに ts-review-graph をセットアップする")
  .option(
    "--tsconfig <path>",
    "tsconfig.json のパス（複数回指定可）",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[]
  )
  .option("--db <path>", "graph.db のパス")
  .action((opts: { tsconfig: string[]; db?: string }) => {
    const projectRoot = process.cwd();
    const graphDir = path.join(projectRoot, ".ts-review-graph");
    const dbPath = opts.db ? path.resolve(opts.db) : path.join(graphDir, "graph.db");

    // 1. ディレクトリ作成
    if (!existsSync(graphDir)) mkdirSync(graphDir, { recursive: true });

    // 2. ignore ファイル生成
    const ignoreFile = path.join(graphDir, "ignore");
    if (!existsSync(ignoreFile)) {
      try {
        writeFileSync(ignoreFile, "node_modules\ndist\n*.d.ts\n.next\n.nuxt\n");
      } catch (err) {
        console.warn(`⚠ ignore ファイルの作成に失敗しました: ${err instanceof Error ? err.message : err}`);
      }
    }

    // 3. .gitignore で SQLite DB と WAL/SHM を除外する
    const gitignorePath = path.join(projectRoot, ".gitignore");
    try {
      const current = existsSync(gitignorePath)
        ? readFileSync(gitignorePath, "utf-8")
        : "";
      const update = updateGraphGitignore(current);
      if (update.changed) {
        writeFileSync(gitignorePath, update.content);
        console.log("✓ .gitignore に graph.db / WAL / SHM の除外を設定しました");
      }
    } catch (err) {
      console.warn(`⚠ .gitignore の更新に失敗しました: ${err instanceof Error ? err.message : err}`);
    }

    // 4. tsconfig リストを解決
    const rawTsconfigs =
      opts.tsconfig.length > 0 ? opts.tsconfig : ["tsconfig.json"];
    const tsconfigPaths = rawTsconfigs.map((p) => path.resolve(p));

    // 4a. tsconfig 存在確認 — 書き込み前に検証して壊れた状態を防ぐ
    const existingPaths = tsconfigPaths.filter(existsSync);
    if (existingPaths.length === 0) {
      console.error(`⚠ tsconfig ファイルが見つかりません: ${tsconfigPaths.join(", ")}`);
      console.error("有効な --tsconfig パスを指定して再実行してください。");
      process.exit(1);
    }

    // 4b. .mcp.json を事前にパース確認 — パース失敗なら書き込みを一切行わない
    const mcpJsonPath = path.join(projectRoot, ".mcp.json");
    let mcpJson: Record<string, unknown> = {};
    if (existsSync(mcpJsonPath)) {
      try {
        mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf-8")) as Record<string, unknown>;
      } catch {
        console.error("⚠ .mcp.json のパースに失敗しました。既存の設定が破損しています。");
        console.error("  手動で修正するか削除してから再実行してください: " + mcpJsonPath);
        process.exit(1);
      }
    }

    // 5. config.json 書き込み — 存在するパスのみを記録する
    const relPaths = existingPaths.map((p) => toProjectRelative(projectRoot, p));
    try {
      writeConfig(projectRoot, { tsconfigs: relPaths });
    } catch (err) {
      console.error("⚠ config.json の書き込みに失敗しました:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    console.log(`✓ config.json に tsconfigs を保存しました: ${relPaths.join(", ")}`);

    // 6. 初回グラフビルド — 成功後にのみ .mcp.json を書き込む
    console.log(`... 初回グラフをビルド中... (${existingPaths.length} tsconfig)`);
    let db: ReturnType<typeof openDb> | undefined;
    try {
      db = openDb(dbPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("⚠ データベースを開けませんでした:", message);
      for (const line of formatNpxAbiMismatchGuidance(message)) {
        console.error(`  ${line}`);
      }
      process.exit(1);
    }
    try {
      buildFullGraph(db!, existingPaths, projectRoot);
    } catch (err) {
      console.error("⚠ グラフ構築に失敗しました:", err instanceof Error ? err.message : err);
      db?.close();
      process.exit(1);
    }
    try {
      const { nodeCount } = db!
        .prepare("SELECT COUNT(*) as nodeCount FROM nodes")
        .get() as { nodeCount: number };
      console.log(`✓ グラフ構築完了 (${nodeCount} nodes)`);
    } catch {
      console.log("✓ グラフ構築完了");
    } finally {
      db?.close();
    }

    // 7. MCP サーバーを .mcp.json に登録 — グラフ構築成功後のみ実行
    const serverEntry = buildMcpServerEntry(projectRoot, dbPath);
    const mcpServers = (mcpJson["mcpServers"] ?? {}) as Record<string, unknown>;
    mcpServers["ts-review-graph"] = serverEntry;
    mcpJson["mcpServers"] = mcpServers;
    try {
      writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + "\n");
    } catch (err) {
      console.error("⚠ .mcp.json の書き込みに失敗しました:", err instanceof Error ? err.message : err);
      console.error("  再度 ts-review-graph install を実行するか、手動で .mcp.json に登録してください: " + mcpJsonPath);
      process.exit(1);
    }
    console.log("✓ MCP サーバーを .mcp.json に登録しました");

    // 8. CLAUDE.md に使用方法セクションを追記（べき等）
    const claudeMdPath = path.join(projectRoot, "CLAUDE.md");
    const claudeMdSection = `
## TypeScript Dependency Graph (ts-review-graph MCP)

### 必須: ソースコード参照前にコンテキスト取得

コードレビュー・実装・デバッグで**ソースファイルを Read する前に**、必ず \`get_minimal_context\` を呼び出すこと。

\`\`\`
mcp__ts-review-graph__get_minimal_context({
  changed_files: ["src/foo.ts"],
  mode: "review"   // review | implement | debug
})
\`\`\`

| mode | 使う場面 |
|------|---------|
| \`review\` | PR レビュー、コード調査 — REVERSE BFS (影響範囲) を返す |
| \`implement\` | 新機能実装 — REVERSE + 深さ1 FORWARD (依存先) を返す |
| \`debug\` | バグ調査 — REVERSE BFS (影響範囲) を返す |

グラフが古い場合は \`mcp__ts-review-graph__build_graph\` で再構築する。
`;
    const CLAUDE_MD_MARKER = "ts-review-graph MCP";
    try {
      if (existsSync(claudeMdPath)) {
        const existing = readFileSync(claudeMdPath, "utf-8");
        if (!existing.includes(CLAUDE_MD_MARKER)) {
          appendFileSync(claudeMdPath, claudeMdSection);
          console.log("✓ CLAUDE.md に ts-review-graph セクションを追記しました");
        } else {
          console.log("✓ CLAUDE.md の ts-review-graph セクションは既に存在します（スキップ）");
        }
      } else {
        writeFileSync(claudeMdPath, claudeMdSection.trimStart());
        console.log("✓ CLAUDE.md を作成し ts-review-graph セクションを追記しました");
      }
    } catch (err) {
      console.warn(`⚠ CLAUDE.md の更新に失敗しました: ${err instanceof Error ? err.message : err}`);
    }

    console.log("\nts-review-graph インストール完了！");
    console.log("Claude Code を再起動して MCP サーバーを有効化してください.");
  });

// --- build ---
program
  .command("build")
  .description("プロジェクトのグラフを再構築する")
  .option(
    "--tsconfig <path>",
    "tsconfig.json のパス（複数回指定可: --tsconfig a.json --tsconfig b.json）",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[]
  )
  .option("--db <path>", "graph.db のパス")
  .action((opts: { tsconfig: string[]; db?: string }) => {
    const dbPath =
      opts.db ? path.resolve(opts.db) : path.join(process.cwd(), ".ts-review-graph/graph.db");
    const projectRoot = process.cwd();

    let tsconfigPaths: string[];

    if (opts.tsconfig.length > 0) {
      tsconfigPaths = opts.tsconfig.map((p) => path.resolve(p));
    } else {
      const config = readConfig(projectRoot);
      if (config) {
        tsconfigPaths = config.tsconfigs.map((p) =>
          path.resolve(projectRoot, p)
        );
        console.log(`config.json から ${tsconfigPaths.length} 件の tsconfig を読み込みました`);
      } else {
        tsconfigPaths = [path.join(projectRoot, "tsconfig.json")];
      }
    }

    const existingPaths = tsconfigPaths.filter(existsSync);
    if (existingPaths.length === 0) {
      console.error(`tsconfig ファイルが見つかりません: ${tsconfigPaths.join(", ")}`);
      process.exit(1);
    }
    const skippedPaths = tsconfigPaths.filter((p) => !existingPaths.includes(p));
    if (skippedPaths.length > 0) {
      console.warn(`⚠ 見つからない tsconfig をスキップします: ${skippedPaths.join(", ")}`);
    }

    let db: ReturnType<typeof openDb> | undefined;
    try {
      db = openDb(dbPath);
    } catch (err) {
      console.error("グラフ DB を開けませんでした:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    try {
      const startMs = Date.now();
      buildFullGraph(db!, existingPaths, projectRoot);
      writeConfig(projectRoot, {
        tsconfigs: existingPaths.map((p) => toProjectRelative(projectRoot, p)),
      });
      const elapsed = Date.now() - startMs;
      console.log(`グラフ構築完了 (${elapsed}ms)`);
      try {
        const { nodeCount } = db!
          .prepare("SELECT COUNT(*) as nodeCount FROM nodes")
          .get() as { nodeCount: number };
        const { edgeCount } = db!
          .prepare("SELECT COUNT(*) as edgeCount FROM edges")
          .get() as { edgeCount: number };
        console.log(`  ${nodeCount} nodes, ${edgeCount} edges`);
      } catch {
        // 統計取得の失敗はグラフ構築の成否に影響しない
      }
    } catch (err) {
      console.error("グラフ構築に失敗しました:", err instanceof Error ? err.message : err);
      process.exit(1);
    } finally {
      db?.close();
    }
  });

// --- update ---
program
  .command("update <file>")
  .description("単一ファイルのグラフを増分更新する")
  .option("--db <path>", "graph.db のパス")
  .action((file: string, opts) => {
    const dbPath =
      typeof opts.db === "string"
        ? path.resolve(opts.db)
        : path.join(process.cwd(), ".ts-review-graph/graph.db");
    const projectRoot = process.cwd();

    if (!existsSync(dbPath)) {
      console.error(
        "グラフが未構築です。まず ts-review-graph install を実行してください。"
      );
      process.exit(1);
    }

    const resolvedFile = path.resolve(file);
    if (!existsSync(resolvedFile)) {
      console.error(`ファイルが見つかりません: ${file}`);
      process.exit(1);
    }

    let db: ReturnType<typeof openDb> | undefined;
    try {
      db = openDb(dbPath);
    } catch (err) {
      console.error("グラフ DB を開けませんでした:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    try {
      const result = updateFile(db!, resolvedFile, projectRoot);
      if (result === "skipped") {
        console.log(`スキップ（変更なし）: ${file}`);
      } else if (result === "deleted") {
        console.log(`削除済みノードをクリア: ${file}`);
      } else {
        console.log(`更新完了: ${file} (TYPED_BY/IMPLEMENTS/EXTENDS/HAS_TEST エッジは次回 build で復元されます)`);
      }
    } catch (err) {
      console.error("更新に失敗しました:", err instanceof Error ? err.message : err);
      process.exit(1);
    } finally {
      db?.close();
    }
  });

// --- status ---
program
  .command("status")
  .description("グラフの状態を表示する")
  .option("--db <path>", "graph.db のパス")
  .action((opts) => {
    const dbPath =
      typeof opts.db === "string"
        ? path.resolve(opts.db)
        : path.join(process.cwd(), ".ts-review-graph/graph.db");
    const projectRoot = process.cwd();

    if (!existsSync(dbPath)) {
      console.error(
        "グラフが未構築です。ts-review-graph install を実行してください。"
      );
      process.exit(1);
    }

    let db: ReturnType<typeof openDb> | undefined;
    try {
      db = openDb(dbPath);
    } catch (err) {
      console.error("グラフ DB を開けませんでした:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    try {
      const { nodeCount } = db!
        .prepare("SELECT COUNT(*) as nodeCount FROM nodes")
        .get() as { nodeCount: number };
      const { edgeCount } = db!
        .prepare("SELECT COUNT(*) as edgeCount FROM edges")
        .get() as { edgeCount: number };
      const { fileCount } = db!
        .prepare("SELECT COUNT(*) as fileCount FROM file_hashes")
        .get() as { fileCount: number };
      const latest = db!
        .prepare("SELECT MAX(updated_at) as t FROM file_hashes")
        .get() as { t: number | null };
      const health = checkGraphHealth(db!, projectRoot);
      const healthText =
        health.status === "ok"
          ? "OK"
          : health.status === "mismatch"
            ? `MISMATCH (${health.reason}) — ${health.detail}`
            : `STALE (${health.staleFiles}/${health.totalFiles} files changed)`;

      console.log("ts-review-graph status:");
      console.log(`  nodes:      ${nodeCount}`);
      console.log(`  edges:      ${edgeCount}`);
      console.log(`  files:      ${fileCount}`);
      console.log(
        `  updated_at: ${latest.t ? new Date(latest.t).toISOString() : "未構築"}`
      );
      console.log(`  health:     ${healthText}`);
    } catch (err) {
      console.error("ステータス取得に失敗しました:", err instanceof Error ? err.message : err);
      process.exit(1);
    } finally {
      db?.close();
    }
  });

// --- uninstall ---
program
  .command("uninstall")
  .description("ts-review-graph をアンインストールする")
  .action(() => {
    const projectRoot = process.cwd();
    const mcpJsonPath = path.join(projectRoot, ".mcp.json");

    if (existsSync(mcpJsonPath)) {
      let mcpJson: Record<string, unknown> | null = null;
      try {
        mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf-8")) as Record<string, unknown>;
      } catch {
        console.warn("⚠ .mcp.json のパースに失敗しました — 手動で ts-review-graph エントリを削除してください。");
      }
      if (mcpJson !== null) {
        const mcpServers = (mcpJson["mcpServers"] ?? {}) as Record<string, unknown>;
        delete mcpServers["ts-review-graph"];
        mcpJson["mcpServers"] = mcpServers;
        try {
          writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + "\n");
          console.log("✓ .mcp.json から MCP サーバー登録を削除しました");
        } catch (err) {
          console.error("⚠ .mcp.json の書き込みに失敗しました:", err instanceof Error ? err.message : err);
          console.error("  手動で ts-review-graph エントリを削除してください: " + mcpJsonPath);
          process.exit(1);
        }
      }
    }

    console.log("グラフデータ (.ts-review-graph/) は手動で削除してください");
    console.log("  rm -rf .ts-review-graph/");
    console.log(".gitignore の .ts-review-graph/graph.db 行も手動で削除してください");
  });

program.parse(process.argv);
