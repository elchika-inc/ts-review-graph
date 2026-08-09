# グラフ整合性の検疫機構 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** グラフ DB を可搬にし、壊れたグラフが「影響なし」と嘘をつけないようにする。

**Architecture:** ファイルパスの絶対 → プロジェクトルート相対への変換を `analyzeProject` / `updateFile` の入口 1 箇所に集約する（`nodes.id` は `file` から導出されるため、入口で相対化すれば id も自動的に相対になる）。構築条件を `meta` テーブルへ記録し、`checkGraphHealth()` 1 関数が CLI と MCP の両経路から呼ばれる。フックは起動コストの実測結果により bash + sqlite3 のまま据え置き、SQL で `schema_version` のみ検査する。

**Tech Stack:** TypeScript (ESM) / better-sqlite3 / ts-morph / vitest / pnpm workspace

**設計書:** `docs/superpowers/specs/2026-08-09-graph-integrity-quarantine-design.md`

## Global Constraints

- 全パッケージ `"type": "module"`。**import パスは `.js` 拡張子必須**（TypeScript ファイルを指す場合も `from "./foo.js"`）
- Node.js 20 以上
- パッケージ間依存は `workspace:*`
- 本文・コメント・コミットメッセージはすべて日本語（技術用語・コード識別子は原語のまま）
- DB に保存するパスは **POSIX 区切り（`/`）のルート相対パス**。先頭に `./` を付けない
- `SCHEMA_VERSION` の値は `"2"`（文字列）
- `graph.db` はビルド成果物。**マイグレーションコードを書かない**
- テストは `packages/core/tests/` と `packages/mcp-server/tests/` に配置し、既存の vitest スタイル（`/tmp/ts-review-graph-*-${randomUUID()}.db` を `beforeEach` で作り `afterEach` で `-wal` `-shm` ごと削除）に従う
- 検証コマンドに pipe を挟まない。`;` や `&&` で連結もしない（exit code が最後のコマンドのものになり個々の失敗が消える）

## 実装者への重要な注意

**指示と実態が矛盾したら、その場で止めて報告すること。** 本計画はコードを読んで書いたが、
読み落としがあり得る。計画どおりに書くと既存テストが壊れる・シグネチャが合わない・
前提のコードが存在しない等が起きたら、推測で辻褄を合わせず報告すること。
シグネチャと成功基準は勝手に変えないこと。裁量で変更した場合は必ず申告すること。

---

### Task 1: パス変換ユーティリティ

`file` 列と `nodes.id` の両方が同じ変換を通ることを保証する土台。

**Files:**
- Create: `packages/core/src/paths.ts`
- Create: `packages/core/tests/paths.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `toProjectRelative(projectRoot: string, filePath: string): string`
  - `toProjectAbsolute(projectRoot: string, relPath: string): string`

- [x] **Step 1: 失敗するテストを書く**

`packages/core/tests/paths.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toProjectRelative, toProjectAbsolute } from "../src/paths.js";

describe("toProjectRelative", () => {
  it("ルート配下の絶対パスを相対 POSIX パスに変換する", () => {
    expect(toProjectRelative("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
  });

  it("既に相対パスならそのまま返す", () => {
    expect(toProjectRelative("/repo", "src/a.ts")).toBe("src/a.ts");
  });

  it("先頭に ./ を付けない", () => {
    expect(toProjectRelative("/repo", "/repo/a.ts")).toBe("a.ts");
  });

  it("末尾スラッシュ付きのルートでも動作する", () => {
    expect(toProjectRelative("/repo/", "/repo/src/a.ts")).toBe("src/a.ts");
  });

  it("ルート外の絶対パスは例外を投げる", () => {
    expect(() => toProjectRelative("/repo", "/other/a.ts")).toThrow(/outside project root/);
  });
});

describe("toProjectAbsolute", () => {
  it("相対パスを絶対パスに戻す", () => {
    expect(toProjectAbsolute("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
  });

  it("往復変換で元に戻る", () => {
    const abs = "/repo/packages/core/src/db.ts";
    expect(toProjectAbsolute("/repo", toProjectRelative("/repo", abs))).toBe(abs);
  });
});
```

- [x] **Step 2: テストを実行して失敗を確認する**

Run: `cd packages/core && npx vitest run tests/paths.test.ts`
Expected: FAIL — `Failed to resolve import "../src/paths.js"`

- [x] **Step 3: 実装する**

`packages/core/src/paths.ts`:

```ts
import path from "node:path";

// DB に保存するパスはプロジェクトルート相対の POSIX パスに統一する。
// これにより graph.db はリポジトリの位置に依存しなくなる（worktree・リポ移動・別マシンで再利用可能）。
export function toProjectRelative(projectRoot: string, filePath: string): string {
  if (!path.isAbsolute(filePath)) {
    return filePath.split(path.sep).join("/");
  }
  const normalizedRoot = path.resolve(projectRoot);
  const rel = path.relative(normalizedRoot, path.resolve(filePath));
  // path.relative はルート外を指すとき ".." で始まる
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path is outside project root: ${filePath}`);
  }
  return rel.split(path.sep).join("/");
}

export function toProjectAbsolute(projectRoot: string, relPath: string): string {
  if (path.isAbsolute(relPath)) return relPath;
  return path.resolve(projectRoot, relPath);
}
```

- [x] **Step 4: テストを実行して成功を確認する**

Run: `cd packages/core && npx vitest run tests/paths.test.ts`
Expected: PASS（7 件）

- [x] **Step 5: エクスポートを追加する**

`packages/core/src/index.ts` の末尾に追記:

```ts
export { toProjectRelative, toProjectAbsolute } from "./paths.js";
```

- [x] **Step 6: コミット**

```bash
git add packages/core/src/paths.ts packages/core/tests/paths.test.ts packages/core/src/index.ts
git commit -m "feat(core): プロジェクトルート相対パス変換ユーティリティを追加"
```

---

### Task 2: meta テーブルと読み書きヘルパ

**Files:**
- Modify: `packages/core/src/db.ts`（DDL に `meta` を追加）
- Create: `packages/core/src/meta.ts`
- Create: `packages/core/tests/meta.test.ts`
- Modify: `packages/core/tests/db.test.ts`（テーブル存在チェックに `meta` を追加）
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `openDb` (`packages/core/src/db.ts`)
- Produces:
  - `SCHEMA_VERSION: string`（値は `"2"`）
  - `interface GraphMeta { schemaVersion: string; tsconfigs: string[]; builtAt: number; builtRoot: string }`
  - `writeMeta(db: Db, meta: GraphMeta): void`
  - `readMeta(db: Db): GraphMeta | null`（`meta` が空、または必須キー欠落なら `null`）

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/tests/meta.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { writeMeta, readMeta, SCHEMA_VERSION } from "../src/meta.js";
import { rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

let testDb: string;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  testDb = `/tmp/ts-review-graph-meta-test-${randomUUID()}.db`;
  db = openDb(testDb);
});

afterEach(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = testDb + ext;
    if (existsSync(p)) rmSync(p);
  }
});

describe("meta", () => {
  it("書き込んだ meta を読み戻せる", () => {
    writeMeta(db, {
      schemaVersion: SCHEMA_VERSION,
      tsconfigs: ["apps/api/tsconfig.json", "packages/db/tsconfig.json"],
      builtAt: 1700000000000,
      builtRoot: "/repo",
    });
    const m = readMeta(db);
    expect(m).not.toBeNull();
    expect(m!.schemaVersion).toBe(SCHEMA_VERSION);
    expect(m!.tsconfigs).toEqual(["apps/api/tsconfig.json", "packages/db/tsconfig.json"]);
    expect(m!.builtAt).toBe(1700000000000);
    expect(m!.builtRoot).toBe("/repo");
  });

  it("tsconfigs はソートして保存される", () => {
    writeMeta(db, {
      schemaVersion: SCHEMA_VERSION,
      tsconfigs: ["b/tsconfig.json", "a/tsconfig.json"],
      builtAt: 1,
      builtRoot: "/repo",
    });
    expect(readMeta(db)!.tsconfigs).toEqual(["a/tsconfig.json", "b/tsconfig.json"]);
  });

  it("meta が空の DB では null を返す", () => {
    expect(readMeta(db)).toBeNull();
  });

  it("二重書き込みしても最後の値が残る", () => {
    writeMeta(db, { schemaVersion: SCHEMA_VERSION, tsconfigs: ["a.json"], builtAt: 1, builtRoot: "/x" });
    writeMeta(db, { schemaVersion: SCHEMA_VERSION, tsconfigs: ["b.json"], builtAt: 2, builtRoot: "/y" });
    const m = readMeta(db)!;
    expect(m.tsconfigs).toEqual(["b.json"]);
    expect(m.builtAt).toBe(2);
    expect(m.builtRoot).toBe("/y");
  });

  it("SCHEMA_VERSION は '2'", () => {
    expect(SCHEMA_VERSION).toBe("2");
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `cd packages/core && npx vitest run tests/meta.test.ts`
Expected: FAIL — `Failed to resolve import "../src/meta.js"`

- [ ] **Step 3: DDL に meta テーブルを追加する**

`packages/core/src/db.ts` の `DDL` テンプレートリテラル内、`CREATE TABLE IF NOT EXISTS file_hashes (...)` の直後に追記:

```sql
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

- [ ] **Step 4: meta.ts を実装する**

`packages/core/src/meta.ts`:

```ts
import type { Db } from "./db.js";

// meta を持たない DB は暗黙の v1（絶対パス保存）とみなす。
// 値を上げたときは、旧 DB が checkGraphHealth で legacy_schema として拒否される。
export const SCHEMA_VERSION = "2";

export interface GraphMeta {
  schemaVersion: string;
  tsconfigs: string[];
  builtAt: number;
  builtRoot: string;
}

export function writeMeta(db: Db, meta: GraphMeta): void {
  const stmt = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  const sorted = [...meta.tsconfigs].sort();
  db.transaction(() => {
    stmt.run("schema_version", meta.schemaVersion);
    stmt.run("tsconfigs", JSON.stringify(sorted));
    stmt.run("built_at", String(meta.builtAt));
    stmt.run("built_root", meta.builtRoot);
  })();
}

export function readMeta(db: Db): GraphMeta | null {
  let rows: { key: string; value: string }[];
  try {
    rows = db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
  } catch {
    // meta テーブル自体が無い DB（v1）
    return null;
  }
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const schemaVersion = map.get("schema_version");
  const tsconfigsRaw = map.get("tsconfigs");
  const builtAtRaw = map.get("built_at");
  const builtRoot = map.get("built_root");
  if (schemaVersion === undefined || tsconfigsRaw === undefined ||
      builtAtRaw === undefined || builtRoot === undefined) {
    return null;
  }
  let tsconfigs: string[];
  try {
    const parsed: unknown = JSON.parse(tsconfigsRaw);
    if (!Array.isArray(parsed)) return null;
    tsconfigs = parsed as string[];
  } catch {
    return null;
  }
  const builtAt = Number(builtAtRaw);
  if (!Number.isFinite(builtAt)) return null;
  return { schemaVersion, tsconfigs, builtAt, builtRoot };
}
```

- [ ] **Step 5: テストを実行して成功を確認する**

Run: `cd packages/core && npx vitest run tests/meta.test.ts`
Expected: PASS（5 件）

- [ ] **Step 6: db.test.ts のテーブル存在チェックを更新する**

`packages/core/tests/db.test.ts` の「テーブルが存在する」テストに 1 行追加:

```ts
      expect(tables).toContain("meta");
```

- [ ] **Step 7: エクスポートを追加してテスト全体を通す**

`packages/core/src/index.ts` に追記:

```ts
export { writeMeta, readMeta, SCHEMA_VERSION } from "./meta.js";
export type { GraphMeta } from "./meta.js";
```

Run: `cd packages/core && npx vitest run`
Expected: 全 PASS

- [ ] **Step 8: コミット**

```bash
git add packages/core/src/db.ts packages/core/src/meta.ts packages/core/src/index.ts packages/core/tests/meta.test.ts packages/core/tests/db.test.ts
git commit -m "feat(core): グラフ構築条件を記録する meta テーブルを追加"
```

---

### Task 3: analyzer のパス相対化

`nodes.id` は `file` から `${file}::${name}` で導出される（`analyzer.ts:40-46`）。
入口で `filePath` を相対化すれば、`id` / `name` / `file` / `fileHashes` のキーがすべて相対になる。

**Files:**
- Modify: `packages/core/src/analyzer.ts`
- Modify: `packages/core/tests/analyzer.test.ts`

**Interfaces:**
- Consumes: `toProjectRelative` (Task 1)
- Produces: `analyzeProject(tsconfigPath: string, projectRoot: string): AnalysisResult`
  （**第 2 引数 `projectRoot` が必須の破壊的変更**）

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/tests/analyzer.test.ts` の末尾に追記:

```ts
describe("analyzeProject のパス相対化", () => {
  it("nodes.file が projectRoot 相対になる", () => {
    const fixtureRoot = path.resolve(__dirname, "fixtures/simple");
    const result = analyzeProject(path.join(fixtureRoot, "tsconfig.json"), fixtureRoot);
    for (const n of result.nodes) {
      expect(path.isAbsolute(n.file)).toBe(false);
      expect(n.file.startsWith("..")).toBe(false);
    }
    expect(result.nodes.some((n) => n.file === "src/a.ts")).toBe(true);
  });

  it("nodes.id も相対パスで構成される", () => {
    const fixtureRoot = path.resolve(__dirname, "fixtures/simple");
    const result = analyzeProject(path.join(fixtureRoot, "tsconfig.json"), fixtureRoot);
    for (const n of result.nodes) {
      expect(n.id.startsWith("/")).toBe(false);
    }
    expect(result.nodes.some((n) => n.id === "src/a.ts::__file__")).toBe(true);
  });

  it("fileHashes のキーも相対パスになる", () => {
    const fixtureRoot = path.resolve(__dirname, "fixtures/simple");
    const result = analyzeProject(path.join(fixtureRoot, "tsconfig.json"), fixtureRoot);
    for (const key of result.fileHashes.keys()) {
      expect(path.isAbsolute(key)).toBe(false);
    }
  });

  it("edges の source_id / target_id も相対パス由来になる", () => {
    const fixtureRoot = path.resolve(__dirname, "fixtures/simple");
    const result = analyzeProject(path.join(fixtureRoot, "tsconfig.json"), fixtureRoot);
    for (const e of result.edges) {
      expect(e.sourceId.startsWith("/")).toBe(false);
      expect(e.targetId.startsWith("/")).toBe(false);
    }
  });
});
```

ファイル先頭に `import path from "node:path";` が無ければ追加すること。
`__dirname` が ESM で使えない場合は既存テストの流儀に合わせる
（既存テストがフィクスチャをどう参照しているかを確認し、同じ方法を使う）。

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `cd packages/core && npx vitest run tests/analyzer.test.ts`
Expected: FAIL — 引数不足の型エラー、または `nodes.file` が絶対パスのまま

- [ ] **Step 3: analyzeProject を修正する**

`packages/core/src/analyzer.ts`:

```ts
// 変更前: export function analyzeProject(tsconfigPath: string): AnalysisResult {
export function analyzeProject(tsconfigPath: string, projectRoot: string): AnalysisResult {
```

`for (const sf of project.getSourceFiles())` ループの先頭を次のように変更する:

```ts
  for (const sf of project.getSourceFiles()) {
    const absPath = sf.getFilePath();
    if (absPath.includes("node_modules")) continue;
    // プロジェクトルート外のファイル（tsconfig の references 等で入り込む）はグラフに含めない
    let filePath: string;
    try {
      filePath = toProjectRelative(projectRoot, absPath);
    } catch {
      continue;
    }
```

以降の `filePath` を使う箇所（`fileHashes.set` / `fileId` / `nodeId` / `name` / `file`）は
そのままで相対パスになる。**`sf.getFullText()` など ts-morph の API 呼び出しに
`filePath` を渡している箇所があれば `absPath` に置き換えること**（ts-morph は絶対パスを要求する）。

同ファイル内で他の `SourceFile` を解決している箇所
（`decl.getModuleSpecifierSourceFile()` など）でも、
取得した絶対パスは `toProjectRelative(projectRoot, ...)` を通してから
`fileId` / `nodeId` に渡すこと。ルート外なら該当エッジをスキップする。

ファイル先頭に import を追加:

```ts
import { toProjectRelative } from "./paths.js";
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `cd packages/core && npx vitest run tests/analyzer.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/core/src/analyzer.ts packages/core/tests/analyzer.test.ts
git commit -m "feat(core)!: analyzeProject が projectRoot 相対でパスを保存するよう変更"
```

---

### Task 4: updater のパス相対化と meta 書き込み

**Files:**
- Modify: `packages/core/src/updater.ts`
- Modify: `packages/core/tests/updater.test.ts`

**Interfaces:**
- Consumes: `toProjectRelative` (Task 1), `writeMeta` / `SCHEMA_VERSION` (Task 2), `analyzeProject` (Task 3)
- Produces:
  - `updateFile(db: Db, filePath: string, projectRoot: string): "skipped" | "updated" | "deleted"`
  - `buildFullGraph(db: Db, tsconfigPaths: string[], projectRoot: string): void`

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/tests/updater.test.ts` の末尾に追記:

```ts
describe("buildFullGraph の meta 書き込み", () => {
  it("meta に schema_version / tsconfigs / built_at / built_root を記録する", () => {
    const fixtureRoot = path.resolve(__dirname, "fixtures/simple");
    const before = Date.now();
    buildFullGraph(db, [path.join(fixtureRoot, "tsconfig.json")], fixtureRoot);
    const m = readMeta(db);
    expect(m).not.toBeNull();
    expect(m!.schemaVersion).toBe(SCHEMA_VERSION);
    expect(m!.tsconfigs).toEqual(["tsconfig.json"]);
    expect(m!.builtAt).toBeGreaterThanOrEqual(before);
    expect(m!.builtRoot).toBe(fixtureRoot);
  });

  it("nodes.file が相対パスで保存される", () => {
    const fixtureRoot = path.resolve(__dirname, "fixtures/simple");
    buildFullGraph(db, [path.join(fixtureRoot, "tsconfig.json")], fixtureRoot);
    const files = db.prepare("SELECT DISTINCT file FROM nodes").all() as { file: string }[];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(path.isAbsolute(f.file)).toBe(false);
    }
  });
});

describe("updateFile のパス相対化", () => {
  it("絶対パスを渡しても file_hashes には相対パスで記録される", () => {
    const filePath = path.join(tmpDir, "a.ts");
    writeFileSync(filePath, "export function foo() {}");

    updateFile(db, filePath, tmpDir);

    const rows = db.prepare("SELECT file FROM file_hashes").all() as { file: string }[];
    expect(rows).toEqual([{ file: "a.ts" }]);
  });

  it("削除されたファイルは相対パスのノードを消す", () => {
    const filePath = path.join(tmpDir, "a.ts");
    writeFileSync(filePath, "export function foo() {}");
    updateFile(db, filePath, tmpDir);
    rmSync(filePath);

    expect(updateFile(db, filePath, tmpDir)).toBe("deleted");
    const rows = db.prepare("SELECT file FROM nodes WHERE file = 'a.ts'").all();
    expect(rows).toEqual([]);
  });
});
```

`readMeta` / `SCHEMA_VERSION` の import を先頭に追加すること:

```ts
import { readMeta, SCHEMA_VERSION } from "../src/meta.js";
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `cd packages/core && npx vitest run tests/updater.test.ts`
Expected: FAIL — 引数不足、または `file` が絶対パスのまま

- [ ] **Step 3: updateFile を修正する**

`packages/core/src/updater.ts:69` を次のように変更する。
**ディスクアクセス（`existsSync` / `readFileSync`）には絶対パスを使い、
DB アクセスには相対パスを使う**点に注意すること。

```ts
export function updateFile(db: Db, filePath: string, projectRoot: string): "skipped" | "updated" | "deleted" {
  const absPath = toProjectAbsolute(projectRoot, filePath);
  const relPath = toProjectRelative(projectRoot, filePath);

  if (!existsSync(absPath)) {
    const stmts = getUpdateStmts(db);
    db.transaction(() => {
      stmts.deleteNodes.run(relPath);
      stmts.deleteHash.run(relPath);
    })();
    return "deleted";
  }

  const content = readFileSync(absPath, "utf-8");
  const newHash = sha256(content);
  const oldHash = getStoredHash(db, relPath);
  // 以降、DB へ渡すパスはすべて relPath を使う
```

関数本体に残る `filePath` の参照をすべて `relPath`（DB 用）か `absPath`（ファイル I/O 用）に
置き換えること。**`filePath` が単独で残っていないことを確認する。**

ファイル先頭に import を追加:

```ts
import { toProjectRelative, toProjectAbsolute } from "./paths.js";
import { writeMeta, SCHEMA_VERSION } from "./meta.js";
```

- [ ] **Step 4: buildFullGraph を修正する**

`packages/core/src/updater.ts:221` を次のように変更する:

```ts
export function buildFullGraph(db: Db, tsconfigPaths: string[], projectRoot: string): void {
  const { insertNode, insertEdge, upsertHash, deleteAllEdges, deleteAllNodes, deleteAllHashes } = getUpdateStmts(db);

  const now = Date.now();

  const allResults = tsconfigPaths.map((p) => analyzeProject(p, projectRoot));
```

既存トランザクション `runAll` の最後（`deleteAll*` と各 INSERT の後）に meta 書き込みを追加する:

```ts
    writeMeta(db, {
      schemaVersion: SCHEMA_VERSION,
      tsconfigs: tsconfigPaths.map((p) => toProjectRelative(projectRoot, p)),
      builtAt: now,
      builtRoot: path.resolve(projectRoot),
    });
```

`writeMeta` は内部で `db.transaction` を使うが、better-sqlite3 のトランザクションは
ネスト時に SAVEPOINT へ自動的にフォールバックするため、外側トランザクション内から
呼んで問題ない。`path` の import が無ければ `import path from "node:path";` を追加すること。

- [ ] **Step 5: テストを実行して成功を確認する**

Run: `cd packages/core && npx vitest run`
Expected: 全 PASS

既存の `updater.test.ts` / `blast.test.ts` が引数不足で落ちる場合は、
呼び出し側に `projectRoot`（多くは `tmpDir` またはフィクスチャのルート）を追加して修正すること。
`blast.test.ts` が絶対パスでクエリしている場合は、相対パスへ書き換える。

- [ ] **Step 6: コミット**

```bash
git add packages/core/src/updater.ts packages/core/tests/updater.test.ts packages/core/tests/blast.test.ts
git commit -m "feat(core)!: updateFile/buildFullGraph を相対パス化し meta を記録する"
```

---

### Task 5: 検疫 API `checkGraphHealth`

**Files:**
- Create: `packages/core/src/health.ts`
- Create: `packages/core/tests/health.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `readMeta` / `SCHEMA_VERSION` (Task 2), `toProjectAbsolute` (Task 1)
- Produces:
  - `type GraphHealth = { status: "ok" } | { status: "mismatch"; reason: "legacy_schema" | "tsconfig_drift"; detail: string } | { status: "drift"; staleFiles: number; totalFiles: number }`
  - `checkGraphHealth(db: Db, projectRoot: string): GraphHealth`

**判定順（最初に該当したものを返す）:**

1. `readMeta` が `null`、または `schemaVersion !== SCHEMA_VERSION` → `mismatch: legacy_schema`
2. `config.json` が読めない、または `meta.tsconfigs` と内容が不一致 → `mismatch: tsconfig_drift`
3. `file_hashes` の各行について `statSync(abs).mtimeMs > row.updated_at`、
   または `statSync` が ENOENT → `staleFiles` に加算。1 件以上なら `drift`
4. それ以外 → `ok`

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/tests/health.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { buildFullGraph } from "../src/updater.js";
import { writeMeta, SCHEMA_VERSION } from "../src/meta.js";
import { checkGraphHealth } from "../src/health.js";
import { rmSync, existsSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

let db: ReturnType<typeof openDb>;
let testDb: string;
let root: string;

// tsconfig と最小のソースを持つプロジェクトを作り、config.json も書く
function makeProject(): string {
  const dir = path.join(os.tmpdir(), `ts-rg-health-${randomUUID()}`);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, ".ts-review-graph"), { recursive: true });
  writeFileSync(path.join(dir, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext" }, include: ["src"] })
  );
  writeFileSync(
    path.join(dir, ".ts-review-graph/config.json"),
    JSON.stringify({ tsconfigs: ["tsconfig.json"] })
  );
  return dir;
}

beforeEach(() => {
  testDb = `/tmp/ts-review-graph-health-test-${randomUUID()}.db`;
  db = openDb(testDb);
  root = makeProject();
});

afterEach(() => {
  db.close();
  for (const ext of ["", "-wal", "-shm"]) {
    const p = testDb + ext;
    if (existsSync(p)) rmSync(p);
  }
  rmSync(root, { recursive: true, force: true });
});

describe("checkGraphHealth", () => {
  it("meta が無い DB は legacy_schema で mismatch", () => {
    const h = checkGraphHealth(db, root);
    expect(h.status).toBe("mismatch");
    expect(h.status === "mismatch" && h.reason).toBe("legacy_schema");
  });

  it("schema_version が古い DB は legacy_schema で mismatch", () => {
    buildFullGraph(db, [path.join(root, "tsconfig.json")], root);
    writeMeta(db, {
      schemaVersion: "1",
      tsconfigs: ["tsconfig.json"],
      builtAt: Date.now(),
      builtRoot: root,
    });
    const h = checkGraphHealth(db, root);
    expect(h.status === "mismatch" && h.reason).toBe("legacy_schema");
  });

  it("構築直後は ok", () => {
    buildFullGraph(db, [path.join(root, "tsconfig.json")], root);
    expect(checkGraphHealth(db, root).status).toBe("ok");
  });

  it("config.json の tsconfigs が増えると tsconfig_drift で mismatch", () => {
    buildFullGraph(db, [path.join(root, "tsconfig.json")], root);
    writeFileSync(
      path.join(root, ".ts-review-graph/config.json"),
      JSON.stringify({ tsconfigs: ["tsconfig.json", "apps/web/tsconfig.json"] })
    );
    const h = checkGraphHealth(db, root);
    expect(h.status === "mismatch" && h.reason).toBe("tsconfig_drift");
  });

  it("config.json が無い場合も tsconfig_drift で mismatch（検証不能は通さない）", () => {
    buildFullGraph(db, [path.join(root, "tsconfig.json")], root);
    rmSync(path.join(root, ".ts-review-graph/config.json"));
    const h = checkGraphHealth(db, root);
    expect(h.status === "mismatch" && h.reason).toBe("tsconfig_drift");
  });

  it("ファイルを更新すると drift になる", () => {
    buildFullGraph(db, [path.join(root, "tsconfig.json")], root);
    const target = path.join(root, "src/a.ts");
    const future = new Date(Date.now() + 60_000);
    utimesSync(target, future, future);
    const h = checkGraphHealth(db, root);
    expect(h.status).toBe("drift");
    expect(h.status === "drift" && h.staleFiles).toBe(1);
    expect(h.status === "drift" && h.totalFiles).toBeGreaterThan(0);
  });

  it("グラフ登録済みファイルが削除されると drift に数える", () => {
    buildFullGraph(db, [path.join(root, "tsconfig.json")], root);
    rmSync(path.join(root, "src/a.ts"));
    const h = checkGraphHealth(db, root);
    expect(h.status).toBe("drift");
    expect(h.status === "drift" && h.staleFiles).toBe(1);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `cd packages/core && npx vitest run tests/health.test.ts`
Expected: FAIL — `Failed to resolve import "../src/health.js"`

- [ ] **Step 3: 実装する**

`packages/core/src/health.ts`:

```ts
import { statSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
import { readMeta, SCHEMA_VERSION } from "./meta.js";
import { toProjectAbsolute } from "./paths.js";

export type GraphHealth =
  | { status: "ok" }
  | { status: "mismatch"; reason: "legacy_schema" | "tsconfig_drift"; detail: string }
  | { status: "drift"; staleFiles: number; totalFiles: number };

const CONFIG_REL_PATH = ".ts-review-graph/config.json";

function readConfiguredTsconfigs(projectRoot: string): string[] | null {
  try {
    const raw = readFileSync(path.join(projectRoot, CONFIG_REL_PATH), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const list = (parsed as { tsconfigs?: unknown }).tsconfigs;
    if (!Array.isArray(list)) return null;
    if (!list.every((v) => typeof v === "string")) return null;
    return [...(list as string[])].sort();
  } catch {
    return null;
  }
}

// 検疫。ゲート系として振る舞うため、客観的に壊れている状態（mismatch）は
// 呼び出し側で fail-closed に倒すこと。drift は警告に留める。
export function checkGraphHealth(db: Db, projectRoot: string): GraphHealth {
  // 1. スキーマ版
  const meta = readMeta(db);
  if (meta === null) {
    return {
      status: "mismatch",
      reason: "legacy_schema",
      detail: "meta テーブルがありません（旧形式のグラフです）",
    };
  }
  if (meta.schemaVersion !== SCHEMA_VERSION) {
    return {
      status: "mismatch",
      reason: "legacy_schema",
      detail: `schema_version=${meta.schemaVersion}（期待値 ${SCHEMA_VERSION}）`,
    };
  }

  // 2. 設定ドリフト — 検証不能（config.json 不在）も通さない
  const configured = readConfiguredTsconfigs(projectRoot);
  if (configured === null) {
    return {
      status: "mismatch",
      reason: "tsconfig_drift",
      detail: `${CONFIG_REL_PATH} が読めません — グラフのスコープを検証できません`,
    };
  }
  const recorded = [...meta.tsconfigs].sort();
  if (JSON.stringify(configured) !== JSON.stringify(recorded)) {
    return {
      status: "mismatch",
      reason: "tsconfig_drift",
      detail: `config.json=[${configured.join(", ")}] / グラフ構築時=[${recorded.join(", ")}]`,
    };
  }

  // 3. ファイルドリフト
  // 注意: グラフに登録済みの既知ファイルのみを検査する。
  // 構築後に新規追加されたファイルは検出しない（include の glob が高コストなため）。
  // その穴は get_minimal_context の NOT IN GRAPH 表示で補う。
  const rows = db
    .prepare("SELECT file, updated_at FROM file_hashes")
    .all() as { file: string; updated_at: number }[];

  let staleFiles = 0;
  for (const row of rows) {
    try {
      const st = statSync(toProjectAbsolute(projectRoot, row.file));
      if (st.mtimeMs > row.updated_at) staleFiles++;
    } catch {
      // ENOENT 等: グラフに残っているがディスクに無い = ドリフト
      staleFiles++;
    }
  }

  if (staleFiles > 0) {
    return { status: "drift", staleFiles, totalFiles: rows.length };
  }
  return { status: "ok" };
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `cd packages/core && npx vitest run tests/health.test.ts`
Expected: PASS（7 件）

- [ ] **Step 5: エクスポートを追加する**

`packages/core/src/index.ts` に追記:

```ts
export { checkGraphHealth } from "./health.js";
export type { GraphHealth } from "./health.js";
```

- [ ] **Step 6: コミット**

```bash
git add packages/core/src/health.ts packages/core/tests/health.test.ts packages/core/src/index.ts
git commit -m "feat(core): グラフ整合性の検疫 API checkGraphHealth を追加"
```

---

### Task 6: MCP のパス解決を相対化 + リポ移動の回帰テスト

**Files:**
- Modify: `packages/mcp-server/src/tools/resolve-path.ts`
- Modify: `packages/mcp-server/src/tools/build-graph.ts:88`
- Modify: `packages/mcp-server/src/tools/*.ts`（`resolveFilePath` の呼び出し側すべて）
- Create: `packages/mcp-server/tests/portability.test.ts`

**Interfaces:**
- Consumes: `toProjectRelative` (Task 1), `buildFullGraph` (Task 4)
- Produces: `resolveFilePath(file: string): string` は**ルート相対パスを返す**ように変更（関数名は据え置き、戻り値の意味が変わる）

- [ ] **Step 1: 失敗するテストを書く（本障害の直接の回帰テスト）**

`packages/mcp-server/tests/portability.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, buildFullGraph, computeBlastRadius } from "@elchika-inc/ts-review-graph-core";
import { cpSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

let rootA: string;
let rootB: string;

function makeProject(dir: string): void {
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, ".ts-review-graph"), { recursive: true });
  writeFileSync(path.join(dir, "src/dep.ts"), "export const dep = 1;\n");
  writeFileSync(path.join(dir, "src/main.ts"), "import { dep } from './dep.js';\nexport const main = dep;\n");
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" }, include: ["src"] })
  );
  writeFileSync(
    path.join(dir, ".ts-review-graph/config.json"),
    JSON.stringify({ tsconfigs: ["tsconfig.json"] })
  );
}

beforeEach(() => {
  rootA = path.join(os.tmpdir(), `ts-rg-portA-${randomUUID()}`);
  rootB = path.join(os.tmpdir(), `ts-rg-portB-${randomUUID()}`);
  makeProject(rootA);
});

afterEach(() => {
  for (const d of [rootA, rootB]) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe("グラフの可搬性（リポジトリ移動シミュレーション）", () => {
  it("プロジェクトごと別ディレクトリへコピーしても同じ結果を返す", () => {
    const dbPathA = path.join(rootA, ".ts-review-graph/graph.db");
    const dbA = openDb(dbPathA);
    buildFullGraph(dbA, [path.join(rootA, "tsconfig.json")], rootA);
    const before = computeBlastRadius(dbA, "src/dep.ts", 2).map((n) => n.file).sort();
    dbA.close();

    // 変更前の値をベースラインとして取る（0 件だと「一致」が無意味になるため下限を確認）
    expect(before).toContain("src/main.ts");

    // プロジェクトを丸ごと別の場所へコピーする（graph.db ごと）
    cpSync(rootA, rootB, { recursive: true });

    const dbB = openDb(path.join(rootB, ".ts-review-graph/graph.db"));
    const after = computeBlastRadius(dbB, "src/dep.ts", 2).map((n) => n.file).sort();
    dbB.close();

    expect(after).toEqual(before);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `cd packages/mcp-server && npx vitest run tests/portability.test.ts`
Expected: PASS する可能性がある。**PASS した場合は Task 3-4 が正しく効いている証拠なので、
そのまま Step 3 へ進む。** FAIL した場合は Task 3-4 の相対化に漏れがあるので、
先にそちらを修正すること。

> このテストは「先に失敗させる」ことより「回帰を固定する」ことが目的である。

- [ ] **Step 3: resolveFilePath を相対パス返却に変更する**

`packages/mcp-server/src/tools/resolve-path.ts` の最後の 2 行（`return resolved;` の直前と `return resolved;`）を変更する。
既存のパストラバーサル検証・シンボリックリンク検証はすべて維持したまま、
**戻り値だけをルート相対に変える**:

```ts
// ファイル末尾の `return resolved;` を次に置き換える
  return toProjectRelative(projectRoot, resolved);
```

ENOENT の早期 return（`if (... code === "ENOENT") return resolved;`）も同様に変更する:

```ts
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
      return toProjectRelative(projectRoot, resolved);
    }
```

ファイル先頭に import を追加:

```ts
import { toProjectRelative } from "@elchika-inc/ts-review-graph-core";
```

コメントの「プロジェクトルート基準の絶対パスに変換する」を
「プロジェクトルート相対のパスに変換する」に修正すること。

- [ ] **Step 4: build_graph ツールを新シグネチャに合わせる**

Task 4 で `buildFullGraph` が 3 引数になったため、`packages/mcp-server/src/tools/build-graph.ts:88`
がコンパイルエラーになる。同ファイルは既に `cwd` としてプロジェクトルートを算出している
（`envDb ? path.resolve(path.dirname(envDb), "..") : process.cwd()`）ので、それをそのまま渡す:

```ts
    buildFullGraph(db, tsconfigPaths, cwd);
```

`loadTsconfigPaths` は `path.join(cwd, p)` で絶対パスを返すため、
`buildFullGraph` 内の `toProjectRelative(projectRoot, p)` は正しく相対化できる。
**`loadTsconfigPaths` は変更しないこと。**

- [ ] **Step 5: 呼び出し側を確認する**

Run: `grep -rn "resolveFilePath" packages/mcp-server/src`

各呼び出し箇所で、戻り値を DB クエリに渡している場合は変更不要（相対パスが正しい）。
戻り値を `existsSync` / `readFileSync` などのファイル I/O に渡している箇所があれば、
`toProjectAbsolute(projectRoot, ...)` を通すこと。

- [ ] **Step 6: テストを実行して成功を確認する**

Run: `pnpm build`
Expected: exit 0（`build-graph.ts` のコンパイルエラーが解消していること）

Run: `cd packages/mcp-server && npx vitest run`
Expected: 全 PASS

- [ ] **Step 7: コミット**

```bash
git add packages/mcp-server/src/tools/resolve-path.ts packages/mcp-server/src/tools/build-graph.ts packages/mcp-server/tests/portability.test.ts
git commit -m "feat(mcp): パス解決をルート相対に変更しリポジトリ移動の回帰テストを追加"
```

---

### Task 7: MCP ツールへの検疫適用

**Files:**
- Modify: `packages/mcp-server/src/tools/index.ts`
- Modify: `packages/mcp-server/src/tools/get-minimal-context.ts`
- Modify: `packages/mcp-server/tests/tools.test.ts`

**Interfaces:**
- Consumes: `checkGraphHealth` / `GraphHealth` (Task 5)
- Produces: `registerTools` の挙動変更（シグネチャは維持）

**適用ルール:**

| 判定 | 挙動 |
|---|---|
| `mismatch` | `isError: true` で結果を返さない。`detail` と「`build_graph` を実行してください」を出す |
| `drift` | 通常の結果の**先頭行**に `⚠ STALE: N files changed since graph build (M total)` を付ける |
| `ok` | 変更なし |

**適用対象:** グラフを読むツールすべて
（`get_minimal_context` / `get_impact` / `get_type_usages` / `get_test_coverage` / `query_graph` / `find_cycles`）。
`build_graph` と `graph_status` は**除外**する（前者は復旧手段そのもの、後者は診断表示のため）。

- [ ] **Step 1: 失敗するテストを書く**

`packages/mcp-server/tests/tools.test.ts` の末尾に追記
（既存テストの DB セットアップ流儀に合わせること。以下は `registerTools` を直接呼ぶ形）:

```ts
describe("検疫の適用", () => {
  it("旧形式 DB では get_minimal_context が isError を返す", () => {
    // meta を持たない DB を作る
    const legacyDb = openDb(`/tmp/ts-rg-legacy-${randomUUID()}.db`);
    try {
      const result = registerTools(legacyDb, "get_minimal_context", {
        changed_files: ["src/a.ts"],
        mode: "review",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("build_graph");
    } finally {
      legacyDb.close();
    }
  });

  it("build_graph は検疫の対象外（旧形式 DB でも拒否されない）", () => {
    const legacyDb = openDb(`/tmp/ts-rg-legacy2-${randomUUID()}.db`);
    try {
      const result = registerTools(legacyDb, "graph_status", {});
      expect(result.isError).not.toBe(true);
    } finally {
      legacyDb.close();
    }
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `cd packages/mcp-server && npx vitest run tests/tools.test.ts`
Expected: FAIL — `isError` が `undefined`

- [ ] **Step 3: registerTools に検疫を組み込む**

`packages/mcp-server/src/tools/index.ts`。まず、既存の
`process.env["TS_REVIEW_GRAPH_DB"]` からプロジェクトルートを導出するヘルパを用意する
（`resolve-path.ts` と同じ導出規則: `dirname(DB_PATH)/..`、未設定なら `process.cwd()`）:

```ts
import path from "node:path";
import { checkGraphHealth } from "@elchika-inc/ts-review-graph-core";

function getProjectRoot(): string {
  const dbPath = process.env["TS_REVIEW_GRAPH_DB"];
  return dbPath ? path.resolve(path.dirname(dbPath), "..") : process.cwd();
}

// 検疫の対象外 — build_graph は復旧手段そのもの、graph_status は診断表示のため
const QUARANTINE_EXEMPT = new Set(["build_graph", "graph_status"]);
```

`registerTools` のディスパッチ直前に検疫を挿入する:

```ts
  if (db && !QUARANTINE_EXEMPT.has(toolName)) {
    const health = checkGraphHealth(db, getProjectRoot());
    if (health.status === "mismatch") {
      return {
        content: [
          {
            type: "text",
            text: [
              `✗ GRAPH MISMATCH — 結果を返しません (${health.reason})`,
              `  ${health.detail}`,
              `  → build_graph ツールを実行してグラフを再構築してください。`,
            ].join("\n"),
          },
        ],
        isError: true,
      };
    }
    if (health.status === "drift") {
      // 結果は返すが、先頭に警告を付ける
      const result = /* 既存のディスパッチ結果 */;
      // 実装方法は Step 4 を参照
    }
  }
```

- [ ] **Step 4: drift 警告の付与を実装する**

Step 3 の擬似コードを、既存ディスパッチを 1 回だけ実行する形に整理する。
`registerTools` の本体を次の構造にすること:

```ts
export function registerTools(db: Db | null, toolName: string, args: Record<string, unknown>): ToolResult {
  let staleNotice: string | null = null;

  if (db && !QUARANTINE_EXEMPT.has(toolName)) {
    const health = checkGraphHealth(db, getProjectRoot());
    if (health.status === "mismatch") {
      return {
        content: [{
          type: "text",
          text: [
            `✗ GRAPH MISMATCH — 結果を返しません (${health.reason})`,
            `  ${health.detail}`,
            `  → build_graph ツールを実行してグラフを再構築してください。`,
          ].join("\n"),
        }],
        isError: true,
      };
    }
    if (health.status === "drift") {
      staleNotice = `⚠ STALE: ${health.staleFiles} files changed since graph build (${health.totalFiles} total)`;
    }
  }

  const result = dispatch(db, toolName, args);   // 既存のディスパッチ処理を関数へ切り出す

  if (staleNotice && result.isError !== true && result.content[0]?.type === "text") {
    result.content[0].text = `${staleNotice}\n\n${result.content[0].text}`;
  }
  return result;
}
```

既存の `switch` / `if` によるツール振り分けを `function dispatch(...)` へそのまま移動すること。
**振り分けのロジック自体は変更しない。**

- [ ] **Step 5: get_minimal_context に NOT IN GRAPH 表示を追加する**

`packages/mcp-server/src/tools/get-minimal-context.ts`。
入力ファイルごとに、`file_hashes` に登録があるかを確認し、無ければ明示する:

```ts
  const known = db
    .prepare("SELECT 1 FROM file_hashes WHERE file = ?");

  const notInGraph = resolvedFiles.filter((f) => known.get(f) === undefined);
```

出力テキストの先頭に、`notInGraph` が空でなければ次を挿入する:

```ts
  if (notInGraph.length > 0) {
    lines.unshift(
      ...notInGraph.map(
        (f) => `NOT IN GRAPH: ${f} — グラフ構築後に追加された可能性があります`
      ),
      ""
    );
  }
```

`resolvedFiles` は `resolveFilePath` を通した後のルート相対パスの配列を指す。
既存コード内で該当する変数名が異なる場合はそれに合わせること。

- [ ] **Step 6: テストを実行して成功を確認する**

Run: `cd packages/mcp-server && npx vitest run`
Expected: 全 PASS

- [ ] **Step 7: コミット**

```bash
git add packages/mcp-server/src/tools/
git add packages/mcp-server/tests/tools.test.ts
git commit -m "feat(mcp): 不整合グラフを fail-closed で拒否しドリフトを警告する検疫を追加"
```

---

### Task 8: CLI の projectRoot 引き渡しと status の health 表示

**Files:**
- Modify: `cli/src/index.ts`

**Interfaces:**
- Consumes: `checkGraphHealth` (Task 5), `buildFullGraph` / `updateFile` の新シグネチャ (Task 4)
- Produces: なし（CLI の出力のみ変化）

- [ ] **Step 1: buildFullGraph / updateFile の呼び出しを修正する**

Run: `grep -n "buildFullGraph\|updateFile" cli/src/index.ts`

`cli/src/index.ts:140` と `:272` の `buildFullGraph(db!, existingPaths)` を
`buildFullGraph(db!, existingPaths, projectRoot)` に変更する。
`update` コマンド内の `updateFile(db, ...)` も第 3 引数に `projectRoot` を追加する。

各コマンドで `projectRoot` が未定義なら、そのコマンド内で
`const projectRoot = process.cwd();` として定義すること
（`--db` 指定時は `path.resolve(path.dirname(dbPath), "..")` を使う）。

- [ ] **Step 2: ビルドを通す**

Run: `pnpm build`
Expected: 型エラーなしで成功

- [ ] **Step 3: status に health 行を追加する**

`cli/src/index.ts:379-385` の出力ブロックに 1 行追加する:

```ts
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
```

import に `checkGraphHealth` を追加すること。

- [ ] **Step 4: 手動で実測する**

```bash
pnpm build
```

```bash
REPO="$(git rev-parse --show-toplevel)"
rm -rf /tmp/ts-rg-manual
mkdir -p /tmp/ts-rg-manual/src
printf 'export const a = 1;\n' > /tmp/ts-rg-manual/src/a.ts
printf '{"compilerOptions":{"target":"ES2022","module":"ESNext"},"include":["src"]}\n' > /tmp/ts-rg-manual/tsconfig.json
cd /tmp/ts-rg-manual
node "$REPO/cli/dist/index.js" install --tsconfig tsconfig.json
node "$REPO/cli/dist/index.js" status
```

Expected: `health: OK` が表示される

続けて、ドリフトを発生させて再度実行する。`REPO` は上のブロックで
リポジトリルートにいるうちに取得した値をそのまま使う（同一シェルで続けて実行すること）。

```bash
touch /tmp/ts-rg-manual/src/a.ts
node "$REPO/cli/dist/index.js" status
```

Expected: `health: STALE (1/1 files changed)`

**この実測結果を、コミットメッセージまたは PR 本文に貼ること。**

- [ ] **Step 5: コミット**

```bash
git add cli/src/index.ts
git commit -m "feat(cli): status に health 行を追加し projectRoot を各コマンドへ引き渡す"
```

---

### Task 9: install が絶対パスを書き込まないようにする

`.mcp.json` は git 管理下であり、そこへ書かれた絶対パスがリポジトリ移動で破綻した
（manako の実障害）。サーバー既定値 `process.cwd()/.ts-review-graph/graph.db` に委ねる。

**Files:**
- Create: `cli/src/mcp-entry.ts`
- Modify: `cli/src/index.ts:157-165`
- Create: `cli/tests/install-mcp-entry.test.ts`

> **なぜ別ファイルに切り出すか**: `cli/src/index.ts` は末尾で `program.parse(process.argv)` を
> トップレベル実行している。テストから `index.ts` を import すると vitest の argv で
> CLI が起動してしまうため、テスト対象の関数は独立したモジュールに置く。

**Interfaces:**
- Consumes: なし
- Produces: なし

- [ ] **Step 1: `cli` パッケージでテストが動くようにする**

`cli/package.json` の `test` スクリプトが `--passWithNoTests` になっているため、
テストファイルを置けばそのまま vitest が拾う。`cli/vitest.config.ts` が無い場合は
`packages/core/vitest.config.ts` と同じ内容で作成すること。

- [ ] **Step 2: 失敗するテストを書く**

`cli/tests/install-mcp-entry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildMcpServerEntry } from "../src/mcp-entry.js";

describe("buildMcpServerEntry", () => {
  it("既定の DB パスなら env を含めない", () => {
    const entry = buildMcpServerEntry("/repo", "/repo/.ts-review-graph/graph.db");
    expect(entry).toEqual({
      command: "npx",
      args: ["-y", "@elchika-inc/ts-review-graph-mcp-server"],
    });
    expect("env" in entry).toBe(false);
  });

  it("既定以外の DB パスなら相対パスの env を書く", () => {
    const entry = buildMcpServerEntry("/repo", "/repo/custom/graph.db");
    expect(entry.env).toEqual({ TS_REVIEW_GRAPH_DB: "custom/graph.db" });
  });
});
```

- [ ] **Step 3: テストを実行して失敗を確認する**

Run: `cd cli && npx vitest run tests/install-mcp-entry.test.ts`
Expected: FAIL — `Failed to resolve import "../src/mcp-entry.js"`

- [ ] **Step 4: 実装する**

`cli/src/mcp-entry.ts` を新規作成する:

```ts
import path from "node:path";

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// .mcp.json は git 管理下に置かれるため、絶対パスを書き込むと
// リポジトリの移動・別マシンでのクローンで壊れる（実障害あり）。
// 既定パスならサーバー側の既定値 process.cwd()/.ts-review-graph/graph.db に委ねる。
export function buildMcpServerEntry(projectRoot: string, dbPath: string): McpServerEntry {
  const entry: McpServerEntry = {
    command: "npx",
    args: ["-y", "@elchika-inc/ts-review-graph-mcp-server"],
  };
  const defaultDb = path.join(projectRoot, ".ts-review-graph/graph.db");
  if (path.resolve(dbPath) !== path.resolve(defaultDb)) {
    entry.env = {
      TS_REVIEW_GRAPH_DB: path.relative(projectRoot, dbPath).split(path.sep).join("/"),
    };
  }
  return entry;
}
```

`cli/src/index.ts:158-162` を置き換える:

```ts
    const serverEntry = buildMcpServerEntry(projectRoot, dbPath);
```

`cli/src/index.ts` の import に追加する:

```ts
import { buildMcpServerEntry } from "./mcp-entry.js";
```

- [ ] **Step 5: 既存の絶対パス env を除去する処理を追加する**

`mcpServers["ts-review-graph"] = serverEntry;` は既存エントリを丸ごと置き換えるため、
古い `env.TS_REVIEW_GRAPH_DB` は自動的に除去される。
**追加のコードは不要。** この挙動をテストで固定する:

`cli/tests/install-mcp-entry.test.ts` に追記:

```ts
  it("既存エントリを置き換えるので古い env は残らない", () => {
    const mcpServers: Record<string, unknown> = {
      "ts-review-graph": {
        command: "npx",
        args: ["-y", "@elchika-inc/ts-review-graph-mcp-server"],
        env: { TS_REVIEW_GRAPH_DB: "/old/absolute/path/graph.db" },
      },
    };
    mcpServers["ts-review-graph"] = buildMcpServerEntry("/repo", "/repo/.ts-review-graph/graph.db");
    expect(mcpServers["ts-review-graph"]).not.toHaveProperty("env");
  });
```

- [ ] **Step 6: テストを実行して成功を確認する**

Run: `cd cli && npx vitest run`
Expected: PASS（3 件）

- [ ] **Step 7: コミット**

```bash
git add cli/src/mcp-entry.ts cli/src/index.ts cli/tests/install-mcp-entry.test.ts cli/vitest.config.ts
git commit -m "fix(cli): .mcp.json へ絶対パスを書き込まないよう install を修正"
```

---

### Task 10: フック入力契約の実測

**このタスクは調査であり、コード変更を含まない。** 実測結果が確定するまで
Task 11 に着手しないこと。

**Files:**
- Create: `packages/plugin/hooks/scripts/README.md`（実測結果を記録する）

**背景:** `pre-read.sh` は `CLAUDE_TOOL_INPUT_FILE_PATH` を参照しているが、
stdin JSON 方式・環境変数方式のいずれでも出力が得られなかった。
**現行 Claude Code が PreToolUse フックへ何を渡すかは未確定である。**

- [ ] **Step 1: フックへの入力を丸ごと記録するプローブを書く**

`/tmp/hook-probe.sh` を作成する（リポジトリには置かない）:

```bash
#!/usr/bin/env bash
{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  echo "--- argv ---"
  printf '%s\n' "$@"
  echo "--- env (CLAUDE_*) ---"
  env | grep '^CLAUDE_' || echo "(none)"
  echo "--- stdin ---"
  cat
  echo
} >> /tmp/hook-probe.log 2>&1
exit 0
```

```bash
chmod +x /tmp/hook-probe.sh
```

- [ ] **Step 2: プローブを PreToolUse(Read) に登録する**

作業中の worktree の `.claude/settings.local.json` に追加する
（グローバル設定は変更しないこと）:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [{ "type": "command", "command": "bash /tmp/hook-probe.sh", "timeout": 5 }]
      }
    ]
  }
}
```

- [ ] **Step 3: 実測する（フックはセッション開始時に読み込まれる点に注意）**

**重要**: Claude Code はフック設定を**セッション開始時に読み込む**。
実行中のセッションで `.claude/settings.local.json` を書き換えても、
そのセッションでは発火しない。設定を書いた**後に開始したセッション**で Read する必要がある。

これを踏まえずに「フックが発火しない」と結論すると偽の失敗になる。手順:

1. Step 2 の設定を書く
2. ログを空にする: `rm -f /tmp/hook-probe.log`
3. **worktree 内で新しい Claude Code セッションを開始する**（既存セッションの再起動でもよい）
4. その新しいセッションで任意のファイルを Read ツールで読む
5. `cat /tmp/hook-probe.log`

Expected: argv / `CLAUDE_*` 環境変数 / stdin のいずれかにファイルパスが現れる

**新しいセッションで Read してもログが空の場合**は、
`.claude/settings.local.json` の配置場所と JSON の妥当性を確認する。
それでも空なら**ここで止めて報告すること**（Task 11 は実行しない）。
「フックの仕組みが使えない」という結論自体が重要な調査結果である。

- [ ] **Step 4: 実測結果を記録する**

`packages/plugin/hooks/scripts/README.md` を作成し、以下を記載する:

- 実測日
- Claude Code のバージョン（`claude --version` の出力）
- PreToolUse フックが受け取る入力の実際の形（argv / 環境変数 / stdin JSON のどれか）
- ファイルパスを取り出すための正確な式
- `/tmp/hook-probe.log` の該当部分の引用

- [ ] **Step 5: プローブを撤収する**

`.claude/settings.local.json` から追加した `hooks` セクションを削除し、
`/tmp/hook-probe.sh` と `/tmp/hook-probe.log` を削除する。

- [ ] **Step 6: コミット**

```bash
git add packages/plugin/hooks/scripts/README.md
git commit -m "docs(plugin): PreToolUse フックの入力契約を実測して記録"
```

---

### Task 11: pre-read.sh の修復と乖離検知テスト

**Task 10 の実測結果が `packages/plugin/hooks/scripts/README.md` に記録済みであることを
前提とする。未記録なら着手しないこと。**

**Files:**
- Modify: `packages/plugin/hooks/scripts/pre-read.sh`
- Modify: `packages/plugin/hooks/scripts/post-write.sh`
- Create: `packages/core/tests/hook-consistency.test.ts`

**Interfaces:**
- Consumes: `SCHEMA_VERSION` (Task 2)
- Produces: なし

- [ ] **Step 1: 失敗するテストを書く**

`packages/core/tests/hook-consistency.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION } from "../src/meta.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const hookPath = path.join(repoRoot, "packages/plugin/hooks/scripts/pre-read.sh");
const dbSchemaPath = path.join(repoRoot, "packages/core/src/db.ts");

// フックは bash + sqlite3 で DB を直接照会するため、core の TypeScript 実装とは
// 別実装になっている。過去に存在しない edge kind 'CALLS' が残り続けた実績があるため、
// 乖離を CI で検知する。
describe("pre-read.sh と core の乖離検知", () => {
  const hook = readFileSync(hookPath, "utf-8");

  it("フックが参照する edge kind がスキーマの定義と矛盾しない", () => {
    const VALID_KINDS = ["IMPORTS_FROM", "TYPED_BY", "IMPLEMENTS", "EXTENDS", "HAS_TEST"];
    // フック内の 'XXX' 形式のリテラルのうち、大文字とアンダースコアのみのものを抽出
    const literals = [...hook.matchAll(/'([A-Z][A-Z_]+)'/g)].map((m) => m[1]);
    const kindLiterals = literals.filter((l) => l !== "SELECT" && l !== "DISTINCT");
    for (const kind of kindLiterals) {
      expect(VALID_KINDS).toContain(kind);
    }
  });

  it("VALID_KINDS が db.ts のスキーマコメントと一致する", () => {
    const dbSrc = readFileSync(dbSchemaPath, "utf-8");
    // db.ts に kind の一覧が記述されていることを確認する（陳腐化検知の起点）
    for (const kind of ["IMPORTS_FROM", "TYPED_BY", "IMPLEMENTS", "EXTENDS"]) {
      expect(dbSrc).toContain(kind);
    }
  });

  it("フックが schema_version を検査している", () => {
    expect(hook).toContain("schema_version");
    expect(hook).toContain(SCHEMA_VERSION);
  });
});
```

`db.ts` に edge kind の一覧が現れない場合は、DDL の直上に次のコメントを追加すること:

```ts
-- edges.kind の取りうる値: IMPORTS_FROM | TYPED_BY | IMPLEMENTS | EXTENDS | HAS_TEST
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `cd packages/core && npx vitest run tests/hook-consistency.test.ts`
Expected: FAIL — `expect(VALID_KINDS).toContain("CALLS")` で落ちる、
および `schema_version` が見つからない

- [ ] **Step 3: pre-read.sh を書き換える**

`packages/plugin/hooks/scripts/pre-read.sh` を全面的に置き換える。
**`FILE_PATH` の取得方法は Task 10 の実測結果に従うこと**
（下記は stdin JSON だった場合の例。実測が環境変数だったならその方式にする）:

```bash
#!/usr/bin/env bash
# PreToolUse(Read): ブラスト半径をアドバイザリとして stdout に出力する
# 入力契約は packages/plugin/hooks/scripts/README.md に実測結果を記録している
# これはアドバイザリのみ: Claude を強制的に制約するものではない

set -euo pipefail

SCHEMA_VERSION="2"
DB_PATH="${TS_REVIEW_GRAPH_DB:-$(pwd)/.ts-review-graph/graph.db}"
PROJECT_ROOT="$(cd "$(dirname "$DB_PATH")/.." && pwd)"

# --- ファイルパスの取得（Task 10 の実測結果に置き換えること） ---
INPUT_JSON="$(cat)"
FILE_PATH="$(printf '%s' "$INPUT_JSON" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

if [ -z "$FILE_PATH" ] || [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# --- 検疫: schema_version が一致しないグラフは使わない ---
DB_VERSION="$(sqlite3 "$DB_PATH" "SELECT value FROM meta WHERE key = 'schema_version'" 2>/dev/null || true)"
if [ "$DB_VERSION" != "$SCHEMA_VERSION" ]; then
  echo "[ts-review-graph] グラフが旧形式です (schema_version=${DB_VERSION:-なし}, 期待値 ${SCHEMA_VERSION})"
  echo "  → ts-review-graph build を実行して再構築してください。ブラスト半径は表示しません。"
  exit 0
fi

# --- パスをプロジェクトルート相対へ正規化する ---
case "$FILE_PATH" in
  /*) REL_PATH="${FILE_PATH#"$PROJECT_ROOT"/}" ;;
  *)  REL_PATH="$FILE_PATH" ;;
esac
# ルート外だった場合（置換が起きず絶対パスのまま）は何もしない
case "$REL_PATH" in
  /*) exit 0 ;;
esac

# シングルクォートを SQL エスケープ（' → ''）してインジェクションを防ぐ
SAFE_PATH="${REL_PATH//\'/\'\'}"

RESULT=$(sqlite3 "$DB_PATH" "
  WITH RECURSIVE blast(node_id, depth, reason) AS (
    SELECT id, 0, 'changed' FROM nodes WHERE file = '${SAFE_PATH}'
    UNION ALL
    SELECT e.source_id, b.depth + 1, e.kind
    FROM blast b JOIN edges e ON e.target_id = b.node_id
    WHERE b.depth < 2
      AND e.kind IN ('IMPORTS_FROM', 'TYPED_BY', 'IMPLEMENTS', 'EXTENDS')
  )
  SELECT DISTINCT n.file, b.reason FROM blast b JOIN nodes n ON n.id = b.node_id
  ORDER BY b.depth, n.file
  LIMIT 20
" 2>/dev/null || true)

if [ -z "$RESULT" ]; then
  exit 0
fi

echo "[ts-review-graph] Blast radius for: $REL_PATH"
echo "READ THESE FILES ONLY:"
while IFS='|' read -r file reason; do
  echo "  $file  [$reason]"
done <<< "$RESULT"
echo "SKIP all other files — not in blast radius."
```

**変更点:** 存在しない edge kind `CALLS` を削除、`schema_version` の検疫を追加、
パスをルート相対へ正規化、入力取得を実測済みの契約に合わせた。

- [ ] **Step 4: post-write.sh を同じ方針で修正する**

`packages/plugin/hooks/scripts/post-write.sh` を確認し、以下を適用する:

- ファイルパスの取得方法を Task 10 の実測結果に合わせる
- `ts-review-graph update` を呼んでいる場合、CLI 側は相対/絶対どちらでも
  受け付けるようになっている（Task 4 で `toProjectAbsolute` / `toProjectRelative` を通すため）ので変更不要
- 存在しない edge kind を参照していれば削除する

変更内容を Step 6 のコミットメッセージに明記すること。

- [ ] **Step 5: テストを実行して成功を確認する**

Run: `cd packages/core && npx vitest run tests/hook-consistency.test.ts`
Expected: PASS（3 件）

シェルスクリプトの構文チェック:

Run: `bash -n packages/plugin/hooks/scripts/pre-read.sh`
Expected: 出力なし・exit 0

Run: `bash -n packages/plugin/hooks/scripts/post-write.sh`
Expected: 出力なし・exit 0

- [ ] **Step 6: 旧形式 DB に対する検疫を手で実測する**

```bash
rm -f /tmp/legacy.db
sqlite3 /tmp/legacy.db "CREATE TABLE nodes (id TEXT, kind TEXT, name TEXT, file TEXT, line INTEGER, type_refs TEXT); CREATE TABLE edges (source_id TEXT, target_id TEXT, kind TEXT);"
```

```bash
printf '{"tool_input":{"file_path":"src/a.ts"}}' > /tmp/hookin.json
TS_REVIEW_GRAPH_DB=/tmp/legacy.db bash packages/plugin/hooks/scripts/pre-read.sh < /tmp/hookin.json
```

Expected: 「グラフが旧形式です」の警告が表示され、ブラスト半径は表示されない

**この出力をコミットメッセージまたは PR 本文に貼ること。**

- [ ] **Step 7: コミット**

```bash
git add packages/plugin/hooks/scripts/pre-read.sh packages/plugin/hooks/scripts/post-write.sh packages/core/tests/hook-consistency.test.ts packages/core/src/db.ts
git commit -m "fix(plugin): pre-read.sh の検疫・相対パス対応と乖離検知テストを追加"
```

---

### Task 12: 全体検証とドキュメント更新

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 全パッケージのビルド・テスト・型チェックを個別に実行する**

`&&` や `;` で連結しないこと（exit code が最後のコマンドのものになり個々の失敗が消える）。

Run: `pnpm build`
Expected: exit 0

Run: `pnpm test`
Expected: exit 0、全テスト PASS

Run: `pnpm lint`
Expected: exit 0

- [ ] **Step 2: CLAUDE.md の Database Schema 節を更新する**

`CLAUDE.md` の「Database Schema」節を次のように更新する:

```markdown
## Database Schema

SQLite 4 テーブル: `nodes`、`edges`、`file_hashes`、`meta`

Edge kinds: `IMPORTS_FROM` | `TYPED_BY` | `IMPLEMENTS` | `EXTENDS` | `HAS_TEST`

**重要**: `nodes.file` と `nodes.id` はプロジェクトルート相対の POSIX パスで保存する。
絶対パスで保存すると、リポジトリの移動・worktree・別マシンでのクローンでグラフが
無言で全件ミスする（実障害あり）。相対化は `analyzeProject` / `updateFile` の入口
1 箇所（`toProjectRelative`）に集約している。

**重要**: `edges.target_id` に意図的に REFERENCES を付けていない。増分更新でファイルを
削除するとき、`source_id` が削除ファイルのエッジだけを CASCADE で消し、
逆方向 (`B→A`) エッジは残す必要があるため。

**重要**: `meta` テーブルはグラフの構築条件（`schema_version` / `tsconfigs` /
`built_at` / `built_root`）を記録する。`checkGraphHealth()` がこれを使って検疫する。
`meta` 不在の DB は旧形式として fail-closed で拒否される。
```

- [ ] **Step 3: README.md に検疫の説明を追加する**

`README.md` の「MCP tools」表の直後に節を追加する:

```markdown
### Graph health checks

Every graph-reading tool validates the graph before answering:

| Condition | Behavior |
|---|---|
| `meta` table missing, or `schema_version` mismatch | **Refuses** — rebuild required |
| `config.json` tsconfigs differ from the recorded set (or `config.json` missing) | **Refuses** — rebuild required |
| Known files changed on disk since the graph was built | Answers, prefixed with `⚠ STALE: N files changed` |

`ts-review-graph status` reports the same verdict on a `health:` line.

Graph paths are stored relative to the project root, so `graph.db` survives
moving the repository, working in a git worktree, or cloning on another machine.
```

- [ ] **Step 4: CHANGELOG.md にエントリを追加する**

既存の書式に合わせて `## [0.5.0]` の節を先頭付近に追加する。
`### Breaking Changes` として以下を明記する:

- `graph.db` のスキーマを変更した。**既存のグラフは再構築が必要**（`ts-review-graph build`）
- `analyzeProject` / `updateFile` / `buildFullGraph` に `projectRoot` 引数を追加した
- `install` が `.mcp.json` に `TS_REVIEW_GRAPH_DB` を書き込まなくなった

`### Fixed` として、リポジトリ移動でグラフが無言で全件ミスしていた問題を記載する。

- [ ] **Step 5: 検証コマンドを再実行する**

Run: `pnpm test`
Expected: exit 0

- [ ] **Step 6: コミット**

```bash
git add README.md CLAUDE.md CHANGELOG.md
git commit -m "docs: グラフ検疫と相対パス保存についてドキュメントを更新"
```

---

## DoneCriteria（worker の担当範囲）

以下をすべて**実測で**確認できた時点で完了とする。実行した検証コマンドとその出力を
報告に含めること。「PASS するはず」を根拠にしないこと。

1. `pnpm build` が exit 0
2. `pnpm test` が exit 0（`&&` で連結せず単独実行して確認する）
3. `pnpm lint` が exit 0
4. `packages/mcp-server/tests/portability.test.ts` の「プロジェクトごと別ディレクトリへ
   コピーしても同じ結果を返す」が PASS し、ベースライン（コピー前）の結果が空でない
5. `packages/core/tests/health.test.ts` の 7 件が PASS
6. `packages/core/tests/hook-consistency.test.ts` の 3 件が PASS
7. Task 8 Step 4 の手動実測で `health: OK` → `health: STALE (1/1 files changed)` の
   遷移を確認し、出力を報告に貼った
8. Task 11 Step 6 の旧形式 DB に対するフック検疫の出力を報告に貼った
9. `packages/plugin/hooks/scripts/README.md` にフック入力契約の実測結果が記録されている

## 司令塔側で検証する項目（worker の範囲外）

- プラグインを導入した実 Claude Code セッションで `pre-read.sh` が発火し出力が観測できること
  （worktree 内の worker には観測不能なため）

## Self-Review 結果

- **仕様カバレッジ**: 設計書 §1→Task 2、§2→Task 1/3/4/6、§3→Task 5、§4→Task 7、
  §5→Task 7/8/11、§6→Task 9、§7→Task 3/5/6/11、§8→本計画の「司令塔側で検証する項目」、
  §9→Task 10。すべてに対応タスクがある。
- **プレースホルダ**: Task 7 Step 3 に擬似コード（`/* 既存のディスパッチ結果 */`）が
  あったため、Step 4 で完全な構造を示す形に修正済み。Task 8 Step 4 の
  `~/path/to/ts-review-graph` を `$(git rev-parse --show-toplevel)` に置換済み。
- **実コードとの突合で見つけた欠陥（修正済み）**:
  - `cli/src/index.ts` は末尾で `program.parse(process.argv)` を実行しているため、
    テストから import すると CLI が起動する → Task 9 で `cli/src/mcp-entry.ts` に切り出す形へ変更
  - `packages/mcp-server/src/tools/build-graph.ts:88` の `buildFullGraph(db, tsconfigPaths)` が
    Task 4 のシグネチャ変更でコンパイルエラーになる → Task 6 Step 4 として明示
  - Claude Code はフック設定をセッション開始時に読み込むため、実行中セッションへの
    設定追加では発火しない → Task 10 Step 3 に手順と偽失敗の注意を追記
- **型整合**: `checkGraphHealth` の戻り値 `GraphHealth` は Task 5 で定義し、
  Task 7（MCP）と Task 8（CLI）で同じ判別子（`status` / `reason` / `detail` /
  `staleFiles` / `totalFiles`）を使用している。`toProjectRelative` /
  `toProjectAbsolute` は Task 1 の定義どおり全タスクで同名で参照している。
