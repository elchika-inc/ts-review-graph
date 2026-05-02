#!/usr/bin/env node
import { Command } from "commander";
import { openDb, buildFullGraph, updateFile } from "@ts-review-graph/core";
import {
  mkdirSync,
  existsSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  .action((opts: { tsconfig: string[] }) => {
    const projectRoot = process.cwd();
    const graphDir = path.join(projectRoot, ".ts-review-graph");
    const dbPath = path.join(graphDir, "graph.db");

    // 1. ディレクトリ作成
    if (!existsSync(graphDir)) mkdirSync(graphDir, { recursive: true });

    // 2. ignore ファイル生成
    const ignoreFile = path.join(graphDir, "ignore");
    if (!existsSync(ignoreFile)) {
      writeFileSync(ignoreFile, "node_modules\ndist\n*.d.ts\n.next\n.nuxt\n");
    }

    // 3. .gitignore を graph.db のみ除外に変更
    const gitignorePath = path.join(projectRoot, ".gitignore");
    if (existsSync(gitignorePath)) {
      let content = readFileSync(gitignorePath, "utf-8");
      if (content.includes("# ts-review-graph\n.ts-review-graph/\n")) {
        content = content.replace(
          "# ts-review-graph\n.ts-review-graph/\n",
          "# ts-review-graph (graph.db はビルド成果物、config.json はコミット対象)\n.ts-review-graph/graph.db\n"
        );
        writeFileSync(gitignorePath, content);
        console.log("✓ .gitignore を更新しました（graph.db のみ除外）");
      } else if (!content.includes(".ts-review-graph/graph.db")) {
        appendFileSync(
          gitignorePath,
          "\n# ts-review-graph (graph.db はビルド成果物、config.json はコミット対象)\n.ts-review-graph/graph.db\n"
        );
        console.log("✓ .gitignore に .ts-review-graph/graph.db を追記しました");
      }
    }

    // 4. tsconfig リストを解決
    const rawTsconfigs =
      opts.tsconfig.length > 0 ? opts.tsconfig : ["tsconfig.json"];
    const tsconfigPaths = rawTsconfigs.map((p) => path.resolve(p));

    // 5. config.json 書き込み
    const relPaths = tsconfigPaths.map((p) => path.relative(projectRoot, p));
    writeConfig(projectRoot, { tsconfigs: relPaths });
    console.log(`✓ config.json に tsconfigs を保存しました: ${relPaths.join(", ")}`);

    // 6. MCP サーバーを .mcp.json に登録
    const mcpJsonPath = path.join(projectRoot, ".mcp.json");
    const serverEntry = {
      command: "npx",
      args: ["-y", "@ts-review-graph/mcp-server"],
      env: { TS_REVIEW_GRAPH_DB: dbPath },
    };
    let mcpJson: Record<string, unknown> = {};
    if (existsSync(mcpJsonPath)) {
      try {
        mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf-8")) as Record<string, unknown>;
      } catch { /* 無効な JSON は上書き */ }
    }
    const mcpServers = (mcpJson["mcpServers"] ?? {}) as Record<string, unknown>;
    mcpServers["ts-review-graph"] = serverEntry;
    mcpJson["mcpServers"] = mcpServers;
    writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + "\n");
    console.log("✓ MCP サーバーを .mcp.json に登録しました");

    // 7. 初回グラフビルド
    const existingPaths = tsconfigPaths.filter(existsSync);
    if (existingPaths.length > 0) {
      console.log(`✓ 初回グラフをビルド中... (${existingPaths.length} tsconfig)`);
      const db = openDb(dbPath);
      try {
        buildFullGraph(db, existingPaths);
        const { nodeCount } = db
          .prepare("SELECT COUNT(*) as nodeCount FROM nodes")
          .get() as { nodeCount: number };
        console.log(`✓ グラフ構築完了 (${nodeCount} nodes)`);
      } catch (err) {
        console.error("⚠ グラフ構築に失敗しました:", err instanceof Error ? err.message : err);
        process.exit(1);
      } finally {
        db.close();
      }
    } else {
      console.error(`⚠ tsconfig.json が見つかりません: ${tsconfigPaths.join(", ")}`);
      console.error("インストールが不完全です。有効な --tsconfig パスを指定して再実行してください。");
      process.exit(1);
    }

    console.log("\nts-review-graph インストール完了！");
    console.log("Claude Code を再起動して MCP サーバーを有効化してください。");
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
    const projectRoot = process.cwd();
    const dbPath =
      opts.db ?? path.join(projectRoot, ".ts-review-graph/graph.db");

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
      console.error(`tsconfig.json が見つかりません: ${tsconfigPaths.join(", ")}`);
      process.exit(1);
    }

    const db = openDb(dbPath);
    try {
      const startMs = Date.now();
      buildFullGraph(db, existingPaths);
      const elapsed = Date.now() - startMs;

      const { nodeCount } = db
        .prepare("SELECT COUNT(*) as nodeCount FROM nodes")
        .get() as { nodeCount: number };
      const { edgeCount } = db
        .prepare("SELECT COUNT(*) as edgeCount FROM edges")
        .get() as { edgeCount: number };

      console.log(
        `グラフ構築完了: ${nodeCount} nodes, ${edgeCount} edges (${elapsed}ms)`
      );
    } catch (err) {
      console.error("グラフ構築に失敗しました:", err instanceof Error ? err.message : err);
      process.exit(1);
    } finally {
      db.close();
    }
  });

// --- update ---
program
  .command("update <file>")
  .description("単一ファイルのグラフを増分更新する")
  .option("--db <path>", "graph.db のパス")
  .action((file: string, opts) => {
    const dbPath =
      (opts.db as string | undefined) ??
      path.join(process.cwd(), ".ts-review-graph/graph.db");

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

    const db = openDb(dbPath);
    try {
      const result = updateFile(db, resolvedFile);
      if (result === "skipped") {
        console.log(`スキップ（変更なし）: ${file}`);
      } else {
        console.log(`更新完了: ${file}`);
      }
    } catch (err) {
      console.error("更新に失敗しました:", err instanceof Error ? err.message : err);
      process.exit(1);
    } finally {
      db.close();
    }
  });

// --- status ---
program
  .command("status")
  .description("グラフの状態を表示する")
  .option("--db <path>", "graph.db のパス")
  .action((opts) => {
    const dbPath =
      (opts.db as string | undefined) ??
      path.join(process.cwd(), ".ts-review-graph/graph.db");

    if (!existsSync(dbPath)) {
      console.error(
        "グラフが未構築です。ts-review-graph install を実行してください。"
      );
      process.exit(1);
    }

    const db = openDb(dbPath);
    try {
      const { nodeCount } = db
        .prepare("SELECT COUNT(*) as nodeCount FROM nodes")
        .get() as { nodeCount: number };
      const { edgeCount } = db
        .prepare("SELECT COUNT(*) as edgeCount FROM edges")
        .get() as { edgeCount: number };
      const { fileCount } = db
        .prepare("SELECT COUNT(*) as fileCount FROM file_hashes")
        .get() as { fileCount: number };
      const latest = db
        .prepare("SELECT MAX(updated_at) as t FROM file_hashes")
        .get() as { t: number | null };

      console.log("ts-review-graph status:");
      console.log(`  nodes:      ${nodeCount}`);
      console.log(`  edges:      ${edgeCount}`);
      console.log(`  files:      ${fileCount}`);
      console.log(
        `  updated_at: ${latest.t ? new Date(latest.t).toISOString() : "未構築"}`
      );
    } catch (err) {
      console.error("ステータス取得に失敗しました:", err instanceof Error ? err.message : err);
      process.exit(1);
    } finally {
      db.close();
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
        writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + "\n");
        console.log("✓ .mcp.json から MCP サーバー登録を削除しました");
      }
    }

    console.log("グラフデータ (.ts-review-graph/) は手動で削除してください");
    console.log("  rm -rf .ts-review-graph/");
    console.log(".gitignore の .ts-review-graph/graph.db 行も手動で削除してください");
  });

program.parse(process.argv);
