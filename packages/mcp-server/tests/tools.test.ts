import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb } from "@ts-review-graph/core";
import { registerTools } from "../src/tools/index.js";
import { rmSync, existsSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const FIXTURE_TSCONFIG = new URL(
  "../../core/tests/fixtures/simple/tsconfig.json",
  import.meta.url
).pathname;

// プロジェクトルートを擬似的に作成し、DB パスを nested に設定する。
// resolveFilePath は TS_REVIEW_GRAPH_DB から projectRoot を逆算するため、
// DB が <projectRoot>/.ts-review-graph/graph.db に配置される形にする。
// randomUUID() で並列実行時のパス衝突を防ぐ。
let TEST_PROJECT_ROOT: string;
let TEST_DB: string;
let IMPL_FILE: string;
let DEP_FILE: string;
let TEST_FILE: string;

let db: ReturnType<typeof openDb>;

beforeEach(() => {
  TEST_PROJECT_ROOT = `/tmp/ts-rg-tools-test-${randomUUID()}`;
  TEST_DB = path.join(TEST_PROJECT_ROOT, ".ts-review-graph", "graph.db");
  IMPL_FILE = path.join(TEST_PROJECT_ROOT, "impl.ts");
  DEP_FILE = path.join(TEST_PROJECT_ROOT, "dep.ts");
  TEST_FILE = path.join(TEST_PROJECT_ROOT, "impl.test.ts");

  // TS_REVIEW_GRAPH_DB を設定して resolveFilePath がプロジェクトルートを正しく解決できるようにする
  process.env["TS_REVIEW_GRAPH_DB"] = TEST_DB;

  db = openDb(TEST_DB);

  // impl.ts ノード (絶対パス)
  db.prepare(
    "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
  ).run("impl::__file__", "file", "impl.ts", IMPL_FILE, 1, "[]");

  // dep.ts ノード（impl.ts が import している、絶対パス）
  db.prepare(
    "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
  ).run("dep::__file__", "file", "dep.ts", DEP_FILE, 1, "[]");

  // impl.test.ts ノード (絶対パス)
  db.prepare(
    "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
  ).run("test::__file__", "test", "impl.test.ts", TEST_FILE, 1, "[]");

  // HAS_TEST: impl → test
  db.prepare(
    "INSERT OR REPLACE INTO edges (source_id, target_id, kind) VALUES (?,?,?)"
  ).run("impl::__file__", "test::__file__", "HAS_TEST");

  // IMPORTS_FROM: impl → dep (impl.ts が dep.ts を import)
  db.prepare(
    "INSERT OR REPLACE INTO edges (source_id, target_id, kind) VALUES (?,?,?)"
  ).run("impl::__file__", "dep::__file__", "IMPORTS_FROM");
});

afterEach(() => {
  delete process.env["TS_REVIEW_GRAPH_DB"];
  db.close();
  rmSync(TEST_PROJECT_ROOT, { recursive: true, force: true });
});

describe("registerTools", () => {
  it("get_minimal_context がファイルリストを含むテキストを返す", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [IMPL_FILE],
      mode: "review",
    });
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("impl.ts");
  });

  it("get_test_coverage がテストファイルを返す", () => {
    const result = registerTools(db, "get_test_coverage", { file: IMPL_FILE });
    expect(result.content[0].text).toContain("impl.test.ts");
  });

  it("graph_status がノード数を返す", () => {
    const result = registerTools(db, "graph_status", {});
    expect(result.content[0].text).toContain("nodes");
    // 3ノード挿入済み (impl.ts, dep.ts, impl.test.ts) — 具体的なカウントを検証
    expect(result.content[0].text).toMatch(/nodes:\s+3/);
  });

  it("graph_status は db=null のときもエラーなしで状態を返す", () => {
    const result = registerTools(null, "graph_status", {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("未構築");
  });

  it("db=null のとき未構築メッセージを返す（build_graph 以外）", () => {
    const result = registerTools(null, "get_impact", { changed_file: "x.ts" });
    expect(result.content[0].text).toContain("未構築");
  });

  it("implement モードで REVERSE と FORWARD の両セクションを含む", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [IMPL_FILE],
      mode: "implement",
    });
    const text = result.content[0].text;
    expect(text).toContain("影響を受けるファイル");
    expect(text).toContain("一緒に変えるべきファイル");
    expect(text).toContain("dep.ts");
  });

  it("review モードでは FORWARD セクションを含まない", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [IMPL_FILE],
      mode: "review",
    });
    const text = result.content[0].text;
    expect(text).not.toContain("一緒に変えるべきファイル");
  });

  it("db=null のとき isError: true を返す", () => {
    const result = registerTools(null, "get_impact", { changed_file: "x.ts" });
    expect(result.isError).toBe(true);
  });

  it("不明なツール名は isError: true を返す", () => {
    const result = registerTools(db, "nonexistent_tool", {});
    expect(result.isError).toBe(true);
  });

  it("get_impact: changed_file が未指定のとき isError を返す", () => {
    const result = registerTools(db, "get_impact", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("changed_file");
  });

  it("get_type_usages: type_name が未指定のとき isError を返す", () => {
    const result = registerTools(db, "get_type_usages", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("type_name");
  });

  it("query_graph: from が未指定のとき isError を返す", () => {
    const result = registerTools(db, "query_graph", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("from");
  });

  it("get_test_coverage: file が未指定のとき isError を返す", () => {
    const result = registerTools(db, "get_test_coverage", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("file");
  });
});

describe("get_minimal_context 引数バリデーション", () => {
  it("changed_files が配列でない場合は isError を返す", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: "single-string",
      mode: "review",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("changed_files must be a non-empty array of non-empty strings");
  });

  it("changed_files が空配列の場合は isError を返す", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [],
      mode: "review",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("changed_files must be a non-empty array of non-empty strings");
  });

  it("mode が不正な値の場合は isError を返す", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [IMPL_FILE],
      mode: "invalid",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mode must be one of");
  });

  it("プロジェクト外の絶対パスは isError を返す", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: ["/etc/passwd"],
      mode: "review",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Path traversal detected");
  });

  it("パストラバーサル（../../）は isError を返す", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: ["../../etc/passwd"],
      mode: "review",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Path traversal detected");
  });

  it("changed_files に非文字列要素が混在する場合は isError を返す", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [IMPL_FILE, 42, null],
      mode: "review",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("changed_files must be a non-empty array of non-empty strings");
  });

  it("changed_files が 101 件の場合は isError を返す（MAX_CHANGED_FILES 境界）", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: Array.from({ length: 101 }, (_, i) => `file${i}.ts`),
      mode: "review",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("at most 100");
  });

  it("changed_files が 100 件の場合は正常に処理される（MAX_CHANGED_FILES 上限ちょうど）", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: Array.from({ length: 100 }, (_, i) => path.join(TEST_PROJECT_ROOT, `nonexistent${i}.ts`)),
      mode: "review",
    });
    expect(result.isError).toBeFalsy();
  });

  it("プロジェクト内へのシンボリックリンクでも外部ターゲットは isError を返す", () => {
    const linkPath = path.join(TEST_PROJECT_ROOT, "escape-link.ts");
    symlinkSync("/etc/passwd", linkPath);
    try {
      const result = registerTools(db, "get_minimal_context", {
        changed_files: [linkPath],
        mode: "review",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Path traversal detected");
    } finally {
      rmSync(linkPath, { force: true });
    }
  });
});

describe("get_impact", () => {
  it("get_impact: テストファイルを含む依存先を返す", () => {
    const result = registerTools(db, "get_impact", { changed_file: IMPL_FILE });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("impl.test.ts");
  });

  it("get_impact: 変更ファイル自身は結果に含まれない", () => {
    const result = registerTools(db, "get_impact", { changed_file: IMPL_FILE });
    expect(result.isError).toBeFalsy();
    // ヘッダー行 "Impact of ..." を除いた本文に変更ファイル自身のパスが現れないことを確認
    const body = result.content[0].text.split("\n").slice(1).join("\n");
    expect(body).not.toContain(IMPL_FILE);
  });

  it("get_impact: 依存元がないファイルは 'No dependents found' を返す", () => {
    const result = registerTools(db, "get_impact", { changed_file: TEST_FILE });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No dependents found");
  });

  it("get_impact: 空文字列の changed_file は isError を返す", () => {
    const result = registerTools(db, "get_impact", { changed_file: "" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("non-empty string");
  });

  it("get_impact: 空白のみの changed_file は isError を返す", () => {
    const result = registerTools(db, "get_impact", { changed_file: "   " });
    expect(result.isError).toBe(true);
  });
});

describe("get_type_usages", () => {
  it("get_type_usages: 型が見つからない場合はメッセージを返す", () => {
    const result = registerTools(db, "get_type_usages", { type_name: "NonExistentType" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No usages found for type");
  });

  it("get_type_usages: type_refs にマッチするノードを返す", () => {
    const typedFile = path.join(TEST_PROJECT_ROOT, "typed.ts");
    db.prepare(
      "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
    ).run("typed::__file__", "file", "typed.ts", typedFile, 1, '["MonitorConfig","string"]');

    const result = registerTools(db, "get_type_usages", { type_name: "MonitorConfig" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("MonitorConfig");
    expect(result.content[0].text).toContain("typed.ts");
  });

  it("get_type_usages: LIKE 特殊文字 % を含む型名でもマッチしない（エスケープ確認）", () => {
    // type_refs に "Partial%Type" を含むノードはなく、% がワイルドカードとして機能しないことを確認
    const result = registerTools(db, "get_type_usages", { type_name: "NoMatch%Type" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No usages found for type");
  });

  it("get_type_usages: LIKE 特殊文字 _ を含む型名でもエスケープされる", () => {
    const result = registerTools(db, "get_type_usages", { type_name: "No_Match_Type" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No usages found for type");
  });

  it("get_type_usages: _ を含む型名でも正しくマッチする（過剰エスケープなし）", () => {
    const underscoreFile = path.join(TEST_PROJECT_ROOT, "underscore_typed.ts");
    db.prepare(
      "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
    ).run("underscore::__file__", "file", "underscore_typed.ts", underscoreFile, 1, '["My_Type"]');
    const result = registerTools(db, "get_type_usages", { type_name: "My_Type" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("My_Type");
    expect(result.content[0].text).toContain("underscore_typed.ts");
  });
});

describe("query_graph", () => {
  it("query_graph: FORWARD 方向で直接依存を返す", () => {
    const result = registerTools(db, "query_graph", {
      from: IMPL_FILE,
      direction: "forward",
      edge_kind: "IMPORTS_FROM",
      depth: 1,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("dep.ts");
  });

  it("query_graph: FORWARD で HAS_TEST エッジが含まれる", () => {
    const result = registerTools(db, "query_graph", {
      from: IMPL_FILE,
      direction: "forward",
      edge_kind: "HAS_TEST",
      depth: 1,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("impl.test.ts");
  });

  it("query_graph: REVERSE 方向で dep.ts の依存元 impl.ts を返す", () => {
    const result = registerTools(db, "query_graph", {
      from: DEP_FILE,
      direction: "reverse",
      edge_kind: "IMPORTS_FROM",
      depth: 1,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("impl.ts");
  });

  it("query_graph: from がDBに存在しない場合は空の結果を返す（isError ではない）", () => {
    const result = registerTools(db, "query_graph", {
      from: path.join(TEST_PROJECT_ROOT, "nonexistent.ts"),
      direction: "forward",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("(empty)");
  });

  it("query_graph: 不正な edge_kind は isError を返す", () => {
    const result = registerTools(db, "query_graph", {
      from: IMPL_FILE,
      edge_kind: "INVALID_KIND",
    });
    expect(result.isError).toBe(true);
  });
});

describe("build_graph", () => {
  it("build_graph: 実際の tsconfig からグラフを構築し、ノードを含む DB を返す", () => {
    const buildDbPath = `/tmp/ts-rg-mcp-build-test-${randomUUID()}.db`;
    const prevDb = process.env["TS_REVIEW_GRAPH_DB"];
    process.env["TS_REVIEW_GRAPH_DB"] = buildDbPath;

    try {
      const result = registerTools(null, "build_graph", {
        tsconfigs: [FIXTURE_TSCONFIG],
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("nodes");
      expect(result.content[0].text).toContain("edges");

      // DB にノードが実際に書き込まれていることを確認
      const verifyDb = openDb(buildDbPath);
      try {
        const { c } = verifyDb.prepare("SELECT COUNT(*) as c FROM nodes").get() as { c: number };
        expect(c).toBeGreaterThan(0);
      } finally {
        verifyDb.close();
      }
    } finally {
      if (prevDb !== undefined) {
        process.env["TS_REVIEW_GRAPH_DB"] = prevDb;
      } else {
        delete process.env["TS_REVIEW_GRAPH_DB"];
      }
      for (const ext of ["", "-wal", "-shm"]) {
        const p = buildDbPath + ext;
        if (existsSync(p)) rmSync(p);
      }
    }
  });

  it("build_graph: 同じ tsconfig で2回実行しても冪等（ノード数が増加しない）", () => {
    const buildDbPath = `/tmp/ts-rg-mcp-build-idempotent-${randomUUID()}.db`;
    const prevDb = process.env["TS_REVIEW_GRAPH_DB"];
    process.env["TS_REVIEW_GRAPH_DB"] = buildDbPath;

    try {
      registerTools(null, "build_graph", { tsconfigs: [FIXTURE_TSCONFIG] });
      const db1 = openDb(buildDbPath);
      const count1 = (db1.prepare("SELECT COUNT(*) as c FROM nodes").get() as { c: number }).c;
      db1.close();

      registerTools(null, "build_graph", { tsconfigs: [FIXTURE_TSCONFIG] });
      const db2 = openDb(buildDbPath);
      const count2 = (db2.prepare("SELECT COUNT(*) as c FROM nodes").get() as { c: number }).c;
      db2.close();

      expect(count2).toBe(count1);
    } finally {
      if (prevDb !== undefined) {
        process.env["TS_REVIEW_GRAPH_DB"] = prevDb;
      } else {
        delete process.env["TS_REVIEW_GRAPH_DB"];
      }
      for (const ext of ["", "-wal", "-shm"]) {
        const p = buildDbPath + ext;
        if (existsSync(p)) rmSync(p);
      }
    }
  });

  it("build_graph: 存在しない tsconfig は isError を返す", () => {
    const result = registerTools(null, "build_graph", {
      tsconfigs: ["/nonexistent/tsconfig.json"],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("tsconfig.json not found");
  });

  it("build_graph: config.json が存在する場合はそこから tsconfigs を読み込む", () => {
    const tmpRoot = `/tmp/ts-rg-config-test-${randomUUID()}`;
    const configDir = path.join(tmpRoot, ".ts-review-graph");
    const configPath = path.join(configDir, "config.json");
    const buildDbPath = path.join(configDir, "graph.db");

    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ tsconfigs: [FIXTURE_TSCONFIG] }));

    const prevDb = process.env["TS_REVIEW_GRAPH_DB"];
    process.env["TS_REVIEW_GRAPH_DB"] = buildDbPath;

    try {
      // tsconfigs 引数なし → build_graph は config.json から読み込む
      const result = registerTools(null, "build_graph", {});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("nodes");
    } finally {
      if (prevDb !== undefined) {
        process.env["TS_REVIEW_GRAPH_DB"] = prevDb;
      } else {
        delete process.env["TS_REVIEW_GRAPH_DB"];
      }
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("get_minimal_context 追加バリデーション", () => {
  it("changed_files 配列内に空文字列が含まれる場合は isError を返す", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [IMPL_FILE, ""],
      mode: "review",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("non-empty strings");
  });

  it("mode を省略した場合はデフォルト 'review' として動作する", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [IMPL_FILE],
      // mode を省略
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("mode=review");
  });

  it("mode が数値（非文字列）の場合は isError を返す", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [IMPL_FILE],
      mode: 42,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mode must be one of");
  });
});

describe("query_graph 追加バリデーション", () => {
  it("不正な direction は isError を返す", () => {
    const result = registerTools(db, "query_graph", {
      from: IMPL_FILE,
      direction: "backwards",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("direction");
  });

  it("depth=0 は 1 にクランプされ depth=1 と同じ結果を返す", () => {
    const r0 = registerTools(db, "query_graph", {
      from: IMPL_FILE,
      direction: "forward",
      edge_kind: "IMPORTS_FROM",
      depth: 0,
    });
    const r1 = registerTools(db, "query_graph", {
      from: IMPL_FILE,
      direction: "forward",
      edge_kind: "IMPORTS_FROM",
      depth: 1,
    });
    expect(r0.isError).toBeFalsy();
    expect(r0.content[0].text).toBe(r1.content[0].text);
  });

  it("depth=11 は 10 にクランプされ正常動作し dep.ts を含む結果を返す", () => {
    const result = registerTools(db, "query_graph", {
      from: IMPL_FILE,
      direction: "forward",
      depth: 11,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("dep.ts");
  });
});

describe("get_test_coverage 追加テスト", () => {
  it("テストファイルが存在しないファイルは 'No test files found' を返す", () => {
    const result = registerTools(db, "get_test_coverage", { file: DEP_FILE });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No test files found");
  });
});

describe("debug モード", () => {
  it("debug モードは REVERSE depth=5 で広範な影響範囲を探索する", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [DEP_FILE],
      mode: "debug",
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    // debug は review/implement と同じ REVERSE 形式で出力
    expect(text).toContain("READ THESE FILES ONLY");
    // dep.ts を IMPORTS_FROM している impl.ts が blast radius に含まれる
    expect(text).toContain("impl.ts");
    // debug モード専用の depth 表示
    expect(text).toContain("mode=debug");
  });

  it("debug モードは 'debug' と mode 表示を含む", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [IMPL_FILE],
      mode: "debug",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("mode=debug");
  });
});

describe("SKIP count の数値検証", () => {
  it("review モード: SKIP count は totalFiles - reverseFiles.size に等しい", () => {
    // DEP_FILE の blast radius: dep.ts (depth=0), impl.ts (depth=1, IMPORTS_FROM)
    // totalFiles = 3, reverseFiles.size = 2 → SKIP = 1
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [DEP_FILE],
      mode: "review",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("SKIP: 1 other files");
  });

  it("implement モード: SKIP count は正しく計算される", () => {
    // DEP_FILE の blast radius:
    //   reverseFiles = {dep.ts: changed, impl.ts: IMPORTS_FROM}
    //   displayedReverse: impl.ts のみ (dep.ts は changedSet で除外)
    //   forwardFiles: dep.ts は何も import しない → 0
    //   changedInGraph = 1 (dep.ts は reverseFiles にある)
    //   shownCount = 1 + 0 + 1 = 2, totalFiles = 3, SKIP = 1
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [DEP_FILE],
      mode: "implement",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("SKIP: 1 other files");
  });
});

describe("get_minimal_context 出力フォーマット", () => {
  it("出力に内部 DB id (__file__) が含まれない", () => {
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [DEP_FILE],
      mode: "review",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toContain("__file__");
  });
});

describe("changedFiles 重複排除", () => {
  it("同じファイルを 2 回渡しても重複排除され 1 回だけ処理する", () => {
    // DEP_FILE を 2 回渡す → reverseFiles は {dep.ts, impl.ts} (2件)
    // totalFiles = 3, SKIP = 1 (重複なしと同じ結果)
    const result = registerTools(db, "get_minimal_context", {
      changed_files: [DEP_FILE, DEP_FILE],
      mode: "review",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("SKIP: 1 other files");
  });
});

describe("query_graph 出力フォーマット", () => {
  it("出力は file::name [kind] 形式で内部 DB id を含まない", () => {
    const result = registerTools(db, "query_graph", {
      from: IMPL_FILE,
      direction: "forward",
      edge_kind: "IMPORTS_FROM",
      depth: 1,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    // 新フォーマット: /path/dep.ts::dep.ts  [file]
    expect(text).toContain("dep.ts");
    // 旧フォーマット (id  [kind]  file) は含まない — id は "dep::__file__" のような値
    expect(text).not.toMatch(/dep::__file__\s+\[/);
    expect(text).not.toContain("__file__");
  });

  it("direction を省略するとデフォルトで forward として動作する", () => {
    const result = registerTools(db, "query_graph", {
      from: IMPL_FILE,
      edge_kind: "IMPORTS_FROM",
      depth: 1,
      // direction を省略
    });
    expect(result.isError).toBeFalsy();
    // forward なら dep.ts が見える
    expect(result.content[0].text).toContain("dep.ts");
  });

  it("同一 db で 2 回呼び出してもキャッシュ経由で正常に動作する", () => {
    const call1 = registerTools(db, "query_graph", { from: IMPL_FILE, direction: "forward", depth: 1 });
    const call2 = registerTools(db, "query_graph", { from: DEP_FILE, direction: "reverse", depth: 1 });
    expect(call1.isError).toBeFalsy();
    expect(call2.isError).toBeFalsy();
    // 2回目もキャッシュ経由で同一 db のステートメントを再利用
    expect(call2.content[0].text).toContain("impl.ts");
  });
});

describe("get_type_usages MAX_TYPE_RESULTS 打ち切り", () => {
  it("501 件以上のマッチで打ち切りメッセージを返す", () => {
    // 501 ノードに type_refs = ["MyUniqueType"] を設定して閾値(500)を超えさせる
    const insert = db.prepare(
      "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, type_refs) VALUES (?,?,?,?,?,?)"
    );
    for (let i = 0; i < 501; i++) {
      const f = path.join(TEST_PROJECT_ROOT, `type_test_${i}.ts`);
      insert.run(`type_test_${i}::__file__`, "file", `type_test_${i}.ts`, f, 1, '["MyUniqueType"]');
    }

    const result = registerTools(db, "get_type_usages", { type_name: "MyUniqueType" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("truncated at 500 results");
    expect(result.content[0].text).toContain("use a more specific type name");
  });
});

describe("出力サニタイズ（改行インジェクション対策）", () => {
  it("query_graph: from に改行が含まれてもレスポンステキストに改行が混入しない", () => {
    const result = registerTools(db, "query_graph", {
      from: `${IMPL_FILE}\nevil-injection`,
      direction: "forward",
      depth: 1,
    });
    // from が DB に存在しないため結果は空だが、isError にならない
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    // from= の値部分に改行が混入していないこと
    expect(text).not.toMatch(/from=.*\nevil-injection/);
  });

  it("get_type_usages: type_name に改行が含まれてもレスポンステキストに混入しない", () => {
    const result = registerTools(db, "get_type_usages", {
      type_name: "SafeType\nevil-injection",
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).not.toContain("\nevil-injection");
  });
});
