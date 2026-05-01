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
import os from "node:os";

const program = new Command();
program.name("ts-review-graph").version("0.1.0");

// --- install ---
program
  .command("install")
  .description("プロジェクトに ts-review-graph をセットアップする")
  .option("--tsconfig <path>", "tsconfig.json のパス", "tsconfig.json")
  .action((opts) => {
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

    // 3. .gitignore に追記
    const gitignorePath = path.join(projectRoot, ".gitignore");
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, "utf-8");
      if (!content.includes(".ts-review-graph/")) {
        appendFileSync(
          gitignorePath,
          "\n# ts-review-graph\n.ts-review-graph/\n"
        );
        console.log("✓ .gitignore に .ts-review-graph/ を追記しました");
      }
    }

    // 4. MCP サーバーを ~/.claude.json に登録
    const claudeConfigPath = path.join(os.homedir(), ".claude.json");
    const serverEntry = {
      command: "npx",
      args: ["ts-review-graph-mcp"],
      env: { TS_REVIEW_GRAPH_DB: dbPath },
    };

    let claudeConfig: Record<string, unknown> = {};
    if (existsSync(claudeConfigPath)) {
      try {
        claudeConfig = JSON.parse(readFileSync(claudeConfigPath, "utf-8")) as Record<string, unknown>;
      } catch {
        // 無効な JSON: 上書きする
      }
    }

    const mcpServers = (claudeConfig["mcpServers"] ?? {}) as Record<string, unknown>;
    mcpServers["ts-review-graph"] = serverEntry;
    claudeConfig["mcpServers"] = mcpServers;
    writeFileSync(claudeConfigPath, JSON.stringify(claudeConfig, null, 2) + "\n");
    console.log("✓ MCP サーバーを ~/.claude.json に登録しました");

    // 5. 初回グラフビルド
    const tsconfigPath = path.resolve(opts.tsconfig as string);
    if (existsSync(tsconfigPath)) {
      console.log("✓ 初回グラフをビルド中...");
      const db = openDb(dbPath);
      try {
        buildFullGraph(db, tsconfigPath);
        const { nodeCount } = db
          .prepare("SELECT COUNT(*) as nodeCount FROM nodes")
          .get() as { nodeCount: number };
        console.log(`✓ グラフ構築完了 (${nodeCount} nodes)`);
      } finally {
        db.close();
      }
    } else {
      console.warn(`⚠ tsconfig.json が見つかりません: ${tsconfigPath}`);
    }

    console.log("\nts-review-graph インストール完了！");
    console.log("Claude Code を再起動して MCP サーバーを有効化してください。");
  });

// --- build ---
program
  .command("build")
  .description("プロジェクトのグラフを再構築する")
  .option("--tsconfig <path>", "tsconfig.json のパス", "tsconfig.json")
  .option("--db <path>", "graph.db のパス")
  .action((opts) => {
    const tsconfigPath = path.resolve(opts.tsconfig as string);
    const dbPath =
      (opts.db as string | undefined) ??
      path.join(process.cwd(), ".ts-review-graph/graph.db");

    if (!existsSync(tsconfigPath)) {
      console.error(`tsconfig.json が見つかりません: ${tsconfigPath}`);
      process.exit(1);
    }

    const db = openDb(dbPath);
    try {
      const startMs = Date.now();
      buildFullGraph(db, tsconfigPath);
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

    const db = openDb(dbPath);
    try {
      const result = updateFile(db, path.resolve(file));
      if (result === "skipped") {
        console.log(`スキップ（変更なし）: ${file}`);
      } else {
        console.log(`更新完了: ${file}`);
      }
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
      console.log(
        "グラフが未構築です。ts-review-graph install を実行してください。"
      );
      return;
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
    } finally {
      db.close();
    }
  });

// --- uninstall ---
program
  .command("uninstall")
  .description("ts-review-graph をアンインストールする")
  .action(() => {
    const claudeConfigPath = path.join(os.homedir(), ".claude.json");
    if (existsSync(claudeConfigPath)) {
      let claudeConfig: Record<string, unknown> = {};
      try {
        claudeConfig = JSON.parse(
          readFileSync(claudeConfigPath, "utf-8")
        ) as Record<string, unknown>;
      } catch {
        return;
      }
      const mcpServers = (claudeConfig["mcpServers"] ?? {}) as Record<
        string,
        unknown
      >;
      delete mcpServers["ts-review-graph"];
      claudeConfig["mcpServers"] = mcpServers;
      writeFileSync(
        claudeConfigPath,
        JSON.stringify(claudeConfig, null, 2) + "\n"
      );
      console.log("✓ MCP サーバー登録を削除しました");
    }
    console.log("グラフデータ (.ts-review-graph/) は手動で削除してください");
    console.log("  rm -rf .ts-review-graph/");
  });

program.parse(process.argv);
