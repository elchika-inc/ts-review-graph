# ts-review-graph v0.2 — Multi-tsconfig + FORWARD BFS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 複数 tsconfig によるグラフカバレッジ拡張と、implement モードでの双方向 BFS により「変更対象ファイルの blast radius」と「一緒に変えるべきファイル」を両方返せるようにする。

**Architecture:** `blast.ts` に FORWARD depth=1 クエリを追加し、`updater.ts` の `buildFullGraph` を配列対応に変更。CLI は `.ts-review-graph/config.json` を読み書きするよう拡張し、MCP の `get_minimal-context` が implement モードで双方向の結果を返す。

**Tech Stack:** TypeScript (ESM), ts-morph, better-sqlite3, Vitest, Commander.js

---

## ファイルマップ

| ファイル | 変更 | 内容 |
|---|---|---|
| `packages/core/src/blast.ts` | 修正 | `computeForwardDeps` 追加 |
| `packages/core/src/index.ts` | 修正 | `computeForwardDeps` export 追加 |
| `packages/core/src/updater.ts` | 修正 | `buildFullGraph(db, paths[])` 複数 tsconfig 対応 |
| `packages/core/tests/blast.test.ts` | 修正 | `computeForwardDeps` テスト追加 |
| `packages/core/tests/updater.test.ts` | 修正 | 複数 tsconfig テスト追加 |
| `packages/mcp-server/src/tools/get-minimal-context.ts` | 修正 | implement モードで FORWARD 追加 |
| `packages/mcp-server/tests/tools.test.ts` | 修正 | implement モード出力テスト更新 |
| `cli/src/index.ts` | 修正 | install: 複数 `--tsconfig` + config.json 書き込み; build: config.json 読み込み |
| `README.md` | 新規 | OSS 向けドキュメント |

---

## Task 1: `computeForwardDeps` — テスト先行

**Files:**
- Modify: `packages/core/tests/blast.test.ts`

- [ ] **Step 1: テストを追記する**

`packages/core/tests/blast.test.ts` の末尾（`});` の後）に以下を追加:

```typescript
import { computeForwardDeps } from "../src/blast.js";

describe("computeForwardDeps", () => {
  it("直接 import しているファイルを返す", () => {
    // monitors.ts が schema.ts を IMPORTS_FROM するケース
    insertNode(db, "monitors::__file__", "monitors.ts");
    insertNode(db, "schema::__file__", "schema.ts");
    insertEdge(db, "monitors::__file__", "schema::__file__", "IMPORTS_FROM");

    const result = computeForwardDeps(db, "monitors.ts");
    const files = result.map((r) => r.file);
    expect(files).toContain("schema.ts");
    expect(files).not.toContain("monitors.ts"); // 自身は含まない
  });

  it("depth=1 固定 — 間接依存は含まない", () => {
    insertNode(db, "a::__file__", "a.ts");
    insertNode(db, "b::__file__", "b.ts");
    insertNode(db, "c::__file__", "c.ts");
    insertEdge(db, "a::__file__", "b::__file__", "IMPORTS_FROM");
    insertEdge(db, "b::__file__", "c::__file__", "IMPORTS_FROM");

    const result = computeForwardDeps(db, "a.ts");
    const files = result.map((r) => r.file);
    expect(files).toContain("b.ts");
    expect(files).not.toContain("c.ts");
  });

  it("import 先がない場合は空配列", () => {
    insertNode(db, "standalone::__file__", "standalone.ts");

    const result = computeForwardDeps(db, "standalone.ts");
    expect(result).toHaveLength(0);
  });
});
```

- [ ] **Step 2: テストが FAIL することを確認**

```bash
cd packages/core && pnpm test 2>&1 | tail -20
```

Expected: `computeForwardDeps` is not a function (または import エラー)

---

## Task 2: `computeForwardDeps` — 実装

**Files:**
- Modify: `packages/core/src/blast.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: `blast.ts` に `computeForwardDeps` を追加する**

`blast.ts` の `DEPTH_FOR_MODE` 関数の後に追加:

```typescript
const FORWARD_DEPS_SQL = `
SELECT DISTINCT n.file, 'direct import' as reason, 1 as depth
FROM nodes src
JOIN edges e ON e.source_id = src.id
  AND e.kind = 'IMPORTS_FROM'
JOIN nodes n ON n.id = e.target_id
WHERE src.file = :changed_file
  AND n.file != :changed_file
`;

export function computeForwardDeps(db: Db, changedFile: string): BlastNode[] {
  return db
    .prepare(FORWARD_DEPS_SQL)
    .all({ changed_file: changedFile }) as BlastNode[];
}
```

- [ ] **Step 2: `index.ts` に export を追加する**

`packages/core/src/index.ts` を以下に変更:

```typescript
export { openDb } from "./db.js";
export type { Db } from "./db.js";
export { analyzeProject } from "./analyzer.js";
export type { GraphNode, GraphEdge, AnalysisResult, NodeKind } from "./analyzer.js";
export { computeBlastRadius, computeForwardDeps, DEPTH_FOR_MODE } from "./blast.js";
export type { BlastNode } from "./blast.js";
export { updateFile, buildFullGraph } from "./updater.js";
```

- [ ] **Step 3: テストが PASS することを確認**

```bash
cd packages/core && pnpm test 2>&1 | tail -20
```

Expected: すべての `computeForwardDeps` テストが PASS

- [ ] **Step 4: コミット**

```bash
git add packages/core/src/blast.ts packages/core/src/index.ts packages/core/tests/blast.test.ts
git commit -m "feat(core): computeForwardDeps — depth=1 前方探索を追加"
```

---

## Task 3: `buildFullGraph` — 複数 tsconfig 対応テスト先行

**Files:**
- Modify: `packages/core/tests/updater.test.ts`

- [ ] **Step 1: 複数 tsconfig テストを追記する**

`updater.test.ts` の import に以下を追加:

```typescript
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import { buildFullGraph } from "../src/updater.js";
```

`describe("updateFile", ...)` ブロックの後に追加:

```typescript
describe("buildFullGraph", () => {
  it("複数 tsconfig のノードを単一 DB にマージする", () => {
    // フィクスチャ1: temp ディレクトリに a.ts
    const dir1 = path.join(os.tmpdir(), `ts-rg-fixture1-${Date.now()}`);
    mkdirSync(dir1, { recursive: true });
    writeFileSync(
      path.join(dir1, "a.ts"),
      "export function greetA() { return 'a'; }"
    );
    writeFileSync(
      path.join(dir1, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "ES2022" }, include: ["a.ts"] })
    );

    // フィクスチャ2: 別 temp ディレクトリに b.ts
    const dir2 = path.join(os.tmpdir(), `ts-rg-fixture2-${Date.now()}`);
    mkdirSync(dir2, { recursive: true });
    writeFileSync(
      path.join(dir2, "b.ts"),
      "export function greetB() { return 'b'; }"
    );
    writeFileSync(
      path.join(dir2, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "ES2022" }, include: ["b.ts"] })
    );

    buildFullGraph(db, [
      path.join(dir1, "tsconfig.json"),
      path.join(dir2, "tsconfig.json"),
    ]);

    // 両方のファイルノードが DB に存在する
    const aNode = db
      .prepare("SELECT * FROM nodes WHERE name = 'greetA'")
      .get();
    expect(aNode).toBeTruthy();

    const bNode = db
      .prepare("SELECT * FROM nodes WHERE name = 'greetB'")
      .get();
    expect(bNode).toBeTruthy();
  });

  it("空配列を渡した場合はノードを挿入しない", () => {
    buildFullGraph(db, []);
    const count = (
      db.prepare("SELECT COUNT(*) as c FROM nodes").get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: テストが FAIL することを確認**

```bash
cd packages/core && pnpm test 2>&1 | grep -E "FAIL|PASS|buildFullGraph"
```

Expected: `buildFullGraph` テストが FAIL（引数が string のため）

---

## Task 4: `buildFullGraph` — 複数 tsconfig 実装

**Files:**
- Modify: `packages/core/src/updater.ts`

- [ ] **Step 1: `buildFullGraph` のシグネチャと実装を変更する**

`updater.ts` の `buildFullGraph` 関数を以下に置き換え:

```typescript
export function buildFullGraph(db: Db, tsconfigPaths: string[]): void {
  const insertNode = db.prepare(INSERT_NODE);
  const insertEdge = db.prepare(INSERT_EDGE);
  const upsertHash = db.prepare(UPSERT_HASH);

  const deleteEdges = db.prepare("DELETE FROM edges");
  const deleteNodes = db.prepare("DELETE FROM nodes");
  const deleteHashes = db.prepare("DELETE FROM file_hashes");

  const now = Date.now();

  const runAll = db.transaction(() => {
    deleteEdges.run();
    deleteNodes.run();
    deleteHashes.run();

    for (const tsconfigPath of tsconfigPaths) {
      const { nodes, edges, fileHashes } = analyzeProject(tsconfigPath);

      for (const n of nodes) {
        insertNode.run({
          id: n.id,
          kind: n.kind,
          name: n.name,
          file: n.file,
          line: n.line,
          signature: n.signature ?? null,
          typeRefs: JSON.stringify(n.typeRefs),
        });
      }
      for (const e of edges) {
        insertEdge.run({
          sourceId: e.sourceId,
          targetId: e.targetId,
          kind: e.kind,
        });
      }
      for (const [file, hash] of fileHashes) {
        upsertHash.run({ file, hash, updatedAt: now });
      }
    }
  });

  runAll();
}
```

- [ ] **Step 2: テストが PASS することを確認**

```bash
cd packages/core && pnpm test 2>&1 | tail -20
```

Expected: 全テスト PASS

- [ ] **Step 3: コミット**

```bash
git add packages/core/src/updater.ts packages/core/tests/updater.test.ts
git commit -m "feat(core): buildFullGraph — 複数 tsconfig をマージしてビルド"
```

---

## Task 5: CLI — config.json 読み書きと `install` 拡張

**Files:**
- Modify: `cli/src/index.ts`

- [ ] **Step 1: ファイル先頭の import に `mkdirSync` を確認し、config 読み書きヘルパーを追加する**

`cli/src/index.ts` の import の後（`const program = new Command();` の前）に追加:

```typescript
const CONFIG_FILE_NAME = ".ts-review-graph/config.json";

interface TsReviewGraphConfig {
  tsconfigs: string[];
}

function readConfig(projectRoot: string): TsReviewGraphConfig | null {
  const configPath = path.join(projectRoot, CONFIG_FILE_NAME);
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as TsReviewGraphConfig;
  } catch {
    return null;
  }
}

function writeConfig(projectRoot: string, config: TsReviewGraphConfig): void {
  const configPath = path.join(projectRoot, CONFIG_FILE_NAME);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}
```

- [ ] **Step 2: `install` コマンドを複数 `--tsconfig` 対応に変更する**

既存の `install` コマンド全体を以下に置き換え:

```typescript
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

    // 3. .gitignore を graph.db のみ除外に変更（.ts-review-graph/ 丸ごとではなく）
    const gitignorePath = path.join(projectRoot, ".gitignore");
    if (existsSync(gitignorePath)) {
      let content = readFileSync(gitignorePath, "utf-8");
      if (content.includes(".ts-review-graph/\n")) {
        // v0.1 → v0.2 移行: ディレクトリ全体 → graph.db のみ
        content = content.replace(
          /# ts-review-graph\n\.ts-review-graph\/\n/,
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

    // 4. tsconfig リストを解決（指定なしは tsconfig.json フォールバック）
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
      args: ["ts-review-graph-mcp"],
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
      } finally {
        db.close();
      }
    } else {
      console.warn(`⚠ tsconfig.json が見つかりません: ${tsconfigPaths.join(", ")}`);
    }

    console.log("\nts-review-graph インストール完了！");
    console.log("Claude Code を再起動して MCP サーバーを有効化してください。");
  });
```

- [ ] **Step 3: `build` コマンドを config.json 参照に変更する**

既存の `build` コマンド全体を以下に置き換え:

```typescript
program
  .command("build")
  .description("プロジェクトのグラフを再構築する")
  .option("--tsconfig <path>", "tsconfig.json のパス（指定時は config.json を上書き）")
  .option("--db <path>", "graph.db のパス")
  .action((opts: { tsconfig?: string; db?: string }) => {
    const projectRoot = process.cwd();
    const dbPath =
      opts.db ?? path.join(projectRoot, ".ts-review-graph/graph.db");

    let tsconfigPaths: string[];

    if (opts.tsconfig) {
      // 明示指定が優先
      tsconfigPaths = [path.resolve(opts.tsconfig)];
    } else {
      // config.json から読み込み（なければ tsconfig.json フォールバック）
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
    } finally {
      db.close();
    }
  });
```

- [ ] **Step 4: ビルドが通ることを確認**

```bash
cd cli && pnpm build 2>&1 | tail -10
```

Expected: エラーなし

- [ ] **Step 5: コミット**

```bash
git add cli/src/index.ts
git commit -m "feat(cli): install — 複数 --tsconfig + config.json 管理; build — config.json 参照"
```

---

## Task 6: MCP `get_minimal_context` — implement モードで FORWARD 追加

**Files:**
- Modify: `packages/mcp-server/src/tools/get-minimal-context.ts`
- Modify: `packages/mcp-server/tests/tools.test.ts`

- [ ] **Step 1: tools.test.ts に implement モードのテストを追加する**

`tools.test.ts` の `beforeEach` に FORWARD 用エッジを追加し、テストを追記する。

まず `beforeEach` を以下に変更（既存の impl → test の HAS_TEST エッジに加え、impl が dep を IMPORTS_FROM するエッジを追加）:

```typescript
beforeEach(() => {
  db = openDb(TEST_DB);

  // impl.ts ノード
  db.prepare(
    "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
  ).run("impl::__file__", "file", "impl.ts", "impl.ts", 1, "[]");

  // dep.ts ノード（impl.ts が import している）
  db.prepare(
    "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
  ).run("dep::__file__", "file", "dep.ts", "dep.ts", 1, "[]");

  // impl.test.ts ノード
  db.prepare(
    "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
  ).run("test::__file__", "test", "impl.test.ts", "impl.test.ts", 1, "[]");

  // HAS_TEST: impl → test
  db.prepare(
    "INSERT OR REPLACE INTO edges (source_id, target_id, kind) VALUES (?,?,?)"
  ).run("impl::__file__", "test::__file__", "HAS_TEST");

  // IMPORTS_FROM: impl → dep (impl.ts が dep.ts を import)
  db.prepare(
    "INSERT OR REPLACE INTO edges (source_id, target_id, kind) VALUES (?,?,?)"
  ).run("impl::__file__", "dep::__file__", "IMPORTS_FROM");
});
```

次に `describe("registerTools", ...)` に implement モードのテストを追加:

```typescript
it("implement モードで REVERSE と FORWARD の両セクションを含む", () => {
  const result = registerTools(db, "get_minimal_context", {
    changed_files: ["impl.ts"],
    mode: "implement",
  });
  const text = result.content[0].text;
  // 影響を受けるセクション（HAS_TEST で test.ts が含まれる）
  expect(text).toContain("影響を受けるファイル");
  // 一緒に変えるべきセクション（dep.ts が FORWARD で含まれる）
  expect(text).toContain("一緒に変えるべきファイル");
  expect(text).toContain("dep.ts");
});

it("review モードでは FORWARD セクションを含まない", () => {
  const result = registerTools(db, "get_minimal_context", {
    changed_files: ["impl.ts"],
    mode: "review",
  });
  const text = result.content[0].text;
  expect(text).not.toContain("一緒に変えるべきファイル");
});
```

- [ ] **Step 2: テストが FAIL することを確認**

```bash
cd packages/mcp-server && pnpm test 2>&1 | grep -E "FAIL|PASS|implement"
```

Expected: implement モードのテストが FAIL

- [ ] **Step 3: `get-minimal-context.ts` を変更する**

ファイル全体を以下に置き換え:

```typescript
import { computeBlastRadius, computeForwardDeps, DEPTH_FOR_MODE } from "@ts-review-graph/core";
import type { Db } from "@ts-review-graph/core";

type ToolResult = { content: Array<{ type: "text"; text: string }> };

export function getMinimalContext(
  db: Db,
  args: Record<string, unknown>
): ToolResult {
  const changedFiles = args["changed_files"] as string[];
  const mode = (args["mode"] as "review" | "implement" | "debug") ?? "review";
  const maxDepth = DEPTH_FOR_MODE(mode);

  const reverseFiles = new Map<string, string>();
  const forwardFiles = new Map<string, string>();

  for (const file of changedFiles) {
    for (const node of computeBlastRadius(db, file, maxDepth)) {
      if (!reverseFiles.has(node.file)) reverseFiles.set(node.file, node.reason);
    }

    if (mode === "implement") {
      for (const node of computeForwardDeps(db, file)) {
        // REVERSE にも含まれるファイルは FORWARD から除外（重複しない）
        if (!reverseFiles.has(node.file) && !forwardFiles.has(node.file)) {
          forwardFiles.set(node.file, node.reason);
        }
      }
    }
  }

  const totalFiles = (
    db.prepare("SELECT COUNT(DISTINCT file) as c FROM nodes").get() as { c: number }
  ).c;

  const lines: string[] = [
    `Changed: ${changedFiles.join(", ")}`,
    ``,
  ];

  if (mode === "implement") {
    lines.push(`── 影響を受けるファイル（REVERSE depth=${maxDepth}） ──`);
    if (reverseFiles.size === 0) {
      lines.push(`  (なし)`);
    } else {
      let i = 1;
      for (const [file, reason] of reverseFiles) {
        if (file === changedFiles[0]) continue; // 変更ファイル自身はスキップ
        lines.push(`  ${i++}. ${file}  [${reason}]`);
      }
    }

    lines.push(``, `── 一緒に変えるべきファイル（FORWARD depth=1） ──`);
    if (forwardFiles.size === 0) {
      lines.push(`  (なし — 他パッケージへの直接依存なし)`);
    } else {
      let i = 1;
      for (const [file, reason] of forwardFiles) {
        lines.push(`  ${i++}. ${file}  [${reason}]`);
      }
    }
  } else {
    lines.push(`READ THESE FILES ONLY (${reverseFiles.size} files, mode=${mode}, depth=${maxDepth}):`);
    let i = 1;
    for (const [file, reason] of reverseFiles) {
      lines.push(`  ${i++}. ${file}  [${reason}]`);
    }
  }

  const shownCount = reverseFiles.size + forwardFiles.size;
  lines.push(
    ``,
    `SKIP: ${Math.max(0, totalFiles - shownCount)} other files — not in blast radius`
  );

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
```

- [ ] **Step 4: テストが PASS することを確認**

```bash
cd packages/mcp-server && pnpm test 2>&1 | tail -20
```

Expected: 全テスト PASS

- [ ] **Step 5: コミット**

```bash
git add packages/mcp-server/src/tools/get-minimal-context.ts packages/mcp-server/tests/tools.test.ts
git commit -m "feat(mcp-server): get_minimal_context — implement モードで FORWARD BFS を追加"
```

---

## Task 7: manako の config.json を更新して再ビルド

**Files:**
- Create/Modify: `/Users/nishikawa/projects/naoto24kawa/manako/.ts-review-graph/config.json`

- [ ] **Step 1: ts-review-graph CLI をビルドする**

```bash
cd /Users/nishikawa/projects/naoto24kawa/ts-review-graph
pnpm build 2>&1 | tail -10
```

Expected: エラーなし

- [ ] **Step 2: manako の config.json を作成する**

```bash
cd /Users/nishikawa/projects/naoto24kawa/manako
cat > .ts-review-graph/config.json << 'EOF'
{
  "tsconfigs": [
    "apps/api/tsconfig.json",
    "apps/web/tsconfig.json",
    "apps/monitor-worker/tsconfig.json"
  ]
}
EOF
```

- [ ] **Step 3: .gitignore を更新する**

`manako/.gitignore` の `.ts-review-graph/` 行を確認し、`graph.db` のみに絞る:

```bash
grep -n "ts-review-graph" /Users/nishikawa/projects/naoto24kawa/manako/.gitignore
```

`# ts-review-graph\n.ts-review-graph/\n` が存在すれば:

```bash
sed -i '' 's|\.ts-review-graph/|.ts-review-graph/graph.db|' /Users/nishikawa/projects/naoto24kawa/manako/.gitignore
```

- [ ] **Step 4: グラフを再ビルドする**

```bash
cd /Users/nishikawa/projects/naoto24kawa/manako
node /Users/nishikawa/projects/naoto24kawa/ts-review-graph/cli/dist/index.js build
```

Expected: `グラフ構築完了: XXXX nodes, XXXX edges` (apps/web が追加されてノード数が増える)

- [ ] **Step 5: apps/web のノードが含まれることを確認**

```bash
sqlite3 /Users/nishikawa/projects/naoto24kawa/manako/.ts-review-graph/graph.db \
  "SELECT app, COUNT(*) as c FROM (
     SELECT CASE 
       WHEN file LIKE '%/apps/web/%' THEN 'apps/web'
       WHEN file LIKE '%/apps/api/%' THEN 'apps/api'
       WHEN file LIKE '%/apps/monitor-worker/%' THEN 'apps/monitor-worker'
       WHEN file LIKE '%/packages/%' THEN 'packages'
       ELSE 'other'
     END as app FROM nodes
   ) GROUP BY app;"
```

Expected: `apps/web` の行が現れる

- [ ] **Step 6: BENCHMARK.md に v0.2 の理論結果を追記する**

`ts-review-graph/BENCHMARK.md` の末尾に追記:

```markdown
---

## v0.2 再測定（multi-tsconfig + FORWARD BFS 後）

### Session B v2: `get_minimal_context` 結果（実測）

```
Changed: apps/api/src/routes/monitors.ts

── 影響を受けるファイル（REVERSE depth=3） ──
  1. apps/api/src/routes/services.ts   [IMPORTS_FROM]
  2. apps/api/src/index.ts             [IMPORTS_FROM]

── 一緒に変えるべきファイル（FORWARD depth=1） ──
  1. packages/db/src/schema.ts         [direct import]
  2. apps/api/src/lib/schemas.ts       [direct import]
  3. apps/api/src/lib/format.ts        [direct import]
  ... (実測値で更新)
```

> 測定日: (実装後に更新)
```

- [ ] **Step 7: コミット（ts-review-graph リポジトリ）**

```bash
cd /Users/nishikawa/projects/naoto24kawa/ts-review-graph
git add BENCHMARK.md
git commit -m "docs: BENCHMARK.md に v0.2 セクションを追加"
```

---

## Task 8: README.md 作成

**Files:**
- Create: `README.md`

- [ ] **Step 1: README.md を作成する**

```markdown
# ts-review-graph

TypeScript プロジェクトの依存グラフを SQLite に構築し、コードレビュー・実装・デバッグ前に「読むべき最小ファイルセット」を Claude Code に伝える MCP サーバー。

## インストール

```bash
npx ts-review-graph install \
  --tsconfig apps/api/tsconfig.json \
  --tsconfig apps/web/tsconfig.json
```

モノレポでは複数の tsconfig を指定できます。設定は `.ts-review-graph/config.json` に保存され、以降の `build` 時に自動参照されます。

## 使い方

### Claude Code での利用

`install` 後に Claude Code を再起動すると `ts-review-graph` MCP が自動接続されます。

実装タスク前に Claude が自動的に呼び出します:

```
get_minimal_context(["apps/api/src/routes/monitors.ts"], "implement")
```

**出力例 (implement モード)**:
```
Changed: apps/api/src/routes/monitors.ts

── 影響を受けるファイル（REVERSE depth=3） ──
  1. apps/api/src/routes/services.ts   [IMPORTS_FROM]

── 一緒に変えるべきファイル（FORWARD depth=1） ──
  1. packages/db/src/schema.ts         [direct import]
  2. apps/api/src/lib/schemas.ts       [direct import]

SKIP: 138 other files — not in blast radius
```

### CLI コマンド

| コマンド | 内容 |
|---|---|
| `ts-review-graph install --tsconfig <path>` | セットアップ + 初回ビルド |
| `ts-review-graph build` | グラフを再構築（config.json 参照） |
| `ts-review-graph update <file>` | 単一ファイルを増分更新 |
| `ts-review-graph status` | グラフの統計を表示 |
| `ts-review-graph uninstall` | MCP 登録を解除 |

### MCP ツール一覧

| ツール | 引数 | 内容 |
|---|---|---|
| `get_minimal_context` | `changed_files[]`, `mode` | 読むべき最小ファイルセット |
| `get_impact` | `changed_file` | 影響を受けるファイルと深さ |
| `get_type_usages` | `type_name` | 型を参照するノード一覧 |
| `get_test_coverage` | `file` | 対応するテストファイル一覧 |
| `query_graph` | `from`, `edge_kind`, `direction`, `depth` | 汎用グラフ探索 |

### モード別 BFS 深さ

| mode | REVERSE | FORWARD |
|---|---|---|
| `review` | 2 | なし |
| `implement` | 3 | 1（直接 import のみ） |
| `debug` | 5 | なし |

## 設定ファイル

`.ts-review-graph/config.json`（`install` 時に自動生成、コミット推奨）:

```json
{
  "tsconfigs": [
    "apps/api/tsconfig.json",
    "apps/web/tsconfig.json"
  ]
}
```

## ベンチマーク

[BENCHMARK.md](./BENCHMARK.md) に実測データを掲載。
```

- [ ] **Step 2: コミット**

```bash
cd /Users/nishikawa/projects/naoto24kawa/ts-review-graph
git add README.md
git commit -m "docs: README.md — OSS 向けドキュメント追加"
```

---

## Self-Review チェックリスト

**Spec coverage:**
- [x] 設定ファイル `.ts-review-graph/config.json` → Task 5
- [x] `.gitignore` を `graph.db` のみ除外 → Task 5
- [x] `install` 複数 `--tsconfig` → Task 5
- [x] `build` config.json 参照 → Task 5
- [x] `buildFullGraph` 複数 tsconfig → Task 4
- [x] `computeForwardDeps` depth=1 → Task 2
- [x] `get_minimal_context` implement モード双方向出力 → Task 6
- [x] manako への適用 → Task 7
- [x] README.md → Task 8

**型一貫性:**
- `computeForwardDeps(db: Db, changedFile: string): BlastNode[]` — Task 2 で定義、Task 6 で import
- `buildFullGraph(db: Db, tsconfigPaths: string[]): void` — Task 4 で変更、Task 5 の CLI で呼び出し
- `TsReviewGraphConfig` — Task 5 内で定義、同ファイル内で使用

**後方互換性:**
- config.json なし → `tsconfig.json` フォールバック ✓ (Task 5)
- `review`/`debug` モードの出力は変化なし ✓ (Task 6)
