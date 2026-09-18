#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import {
  assertAbsoluteOutputDirectory,
  assertSafeCrgPaths,
  assertSafeDatabasePath,
  assertSafeOutputDirectory,
  validateRepositoryName,
} from "./safety.mjs";

const {
  DEPTH_FOR_MODE,
  buildFullGraph,
  computeBlastRadius,
  computeForwardDeps,
  openDb,
} = await import(new URL("../../packages/core/dist/index.js", import.meta.url).href);

const requireFromCore = createRequire(new URL("../../packages/core/package.json", import.meta.url));
const { Project } = requireFromCore("ts-morph");
const Database = requireFromCore("better-sqlite3");
const CRG_VERSION = "2.3.8";
const COMPARISON_DEPTHS = [2, 3];

const SINCE = "2026-02-17";
const MIN_CHANGED_FILES = 2;
const MAX_CHANGED_FILES = 10;
const IMPORT_ONLY_EDGE_KINDS = ["IMPORTS_FROM"];
const DEFAULT_REPOSITORIES = [
  {
    name: "manako",
    root: "/Users/nishikawa/projects/elchika-inc/manako",
    expectedHead: "412df2b4a66b8afdc4d2c6619457bd15dcb393fa",
  },
  {
    name: "todoke",
    root: "/Users/nishikawa/projects/elchika-inc/todoke",
    expectedHead: "59ee17770255d7963597c73c2c84e019d76def04",
  },
  {
    name: "miseru",
    root: "/Users/nishikawa/projects/elchika-inc/miseru",
    expectedHead: "6aa3b7f0c8b91e687f6f7fa9303b5e9f5a9baeed",
  },
];

function usage() {
  return `Usage: node scripts/bench/benchmark.mjs [options]

Options:
  --repo <name=/absolute/path>  測定対象を追加（複数回指定可）
  --out-dir <absolute/path>     scratch DB 出力先
  --help                        このヘルプを表示

--repo 省略時は委任仕様の3リポジトリを使います。
出力先の既定値は <os.tmpdir()>/ts-review-graph-bench です。
TS_REVIEW_GRAPH_BENCH_OUT で既定値を上書きできます。`;
}

function parseArgs(argv) {
  const repositories = [];
  const configuredOutDir = process.env.TS_REVIEW_GRAPH_BENCH_OUT;
  let outDir = configuredOutDir === undefined
    ? path.join(tmpdir(), "ts-review-graph-bench")
    : assertAbsoluteOutputDirectory(configuredOutDir, "TS_REVIEW_GRAPH_BENCH_OUT");

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--repo") {
      const assignment = argv[index + 1];
      index += 1;
      const separator = assignment?.indexOf("=") ?? -1;
      if (separator <= 0) {
        throw new Error("--repo は name=/absolute/path 形式で指定してください");
      }
      const name = assignment.slice(0, separator);
      const root = assignment.slice(separator + 1);
      if (!path.isAbsolute(root)) {
        throw new Error(`--repo ${name} の path は絶対パスで指定してください`);
      }
      repositories.push({ name: validateRepositoryName(name), root: path.resolve(root) });
      continue;
    }
    if (arg === "--out-dir") {
      const value = argv[index + 1];
      index += 1;
      if (!value) {
        throw new Error("--out-dir の値を指定してください");
      }
      outDir = assertAbsoluteOutputDirectory(value, "--out-dir");
      continue;
    }
    throw new Error(`未対応の引数: ${arg}`);
  }

  const selected = repositories.length > 0 ? repositories : DEFAULT_REPOSITORIES;
  const names = new Set();
  for (const repository of selected) {
    validateRepositoryName(repository.name);
    if (names.has(repository.name)) {
      throw new Error(`リポジトリ名が重複しています: ${repository.name}`);
    }
    names.add(repository.name);
    if (!existsSync(path.join(repository.root, ".git"))) {
      throw new Error(`Git リポジトリが見つかりません: ${repository.root}`);
    }
  }

  return { repositories: selected, outDir: path.resolve(outDir) };
}

function runGit(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function readTsconfigs(root) {
  const configPath = path.join(root, ".ts-review-graph", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!Array.isArray(config.tsconfigs) || config.tsconfigs.length === 0) {
    throw new Error(`tsconfigs が空です: ${configPath}`);
  }
  const tsconfigs = config.tsconfigs.map((relativePath) => path.resolve(root, relativePath));
  const missing = tsconfigs.filter((tsconfig) => !existsSync(tsconfig));
  if (missing.length > 0) {
    throw new Error(`tsconfig が見つかりません: ${missing.join(", ")}`);
  }
  return tsconfigs;
}

function snapshotFiles(root, snapshot) {
  const output = runGit(root, ["ls-tree", "-r", "--name-only", snapshot]);
  return new Set(output === "" ? [] : output.split("\n"));
}

function eligibleCommits(root, trackedProjectFiles) {
  const output = runGit(root, [
    "log",
    "--no-merges",
    `--since=${SINCE}`,
    "--format=%H",
  ]);
  const commits = output === "" ? [] : output.split("\n").sort();
  const eligible = [];

  for (const sha of commits) {
    const changedOutput = runGit(root, [
      "show",
      "--no-renames",
      "--name-only",
      "--format=",
      "--diff-filter=AM",
      sha,
      "--",
      "*.ts",
      "*.tsx",
    ]);
    const files = [...new Set(changedOutput === "" ? [] : changedOutput.split("\n"))]
      .filter(Boolean)
      .sort();
    if (files.length < MIN_CHANGED_FILES || files.length > MAX_CHANGED_FILES) continue;
    if (!files.every((file) => trackedProjectFiles.has(file))) continue;
    eligible.push({ sha, files });
  }

  return eligible;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rounded(value) {
  return value === null ? null : Number(value.toFixed(6));
}

function score(prediction, groundTruth) {
  prediction = new Set([...prediction].sort());
  let hits = 0;
  for (const file of prediction) {
    if (groundTruth.has(file)) hits += 1;
  }
  return {
    recall: hits / groundTruth.size,
    precision: prediction.size === 0 ? null : hits / prediction.size,
    hits,
    predictedFiles: prediction.size,
  };
}

function scoreForEvaluation(prediction, groundTruth, trackedProjectFiles) {
  const trackedPrediction = new Set(
    [...prediction].filter((file) => trackedProjectFiles.has(file))
  );
  return {
    tracked: score(trackedPrediction, groundTruth),
    workingTree: score(prediction, groundTruth),
  };
}

function summarizeScores(scores) {
  const recalls = scores.map((entry) => entry.recall);
  const precisions = scores
    .map((entry) => entry.precision)
    .filter((value) => value !== null);
  return {
    meanRecall: rounded(mean(recalls)),
    medianRecall: rounded(median(recalls)),
    meanPrecision: rounded(mean(precisions)),
    medianPrecision: rounded(median(precisions)),
    precisionExcluded: scores.length - precisions.length,
    meanPredictedFiles: rounded(mean(scores.map((entry) => entry.predictedFiles))),
  };
}

function summarizeRecallDelta(fullScores, ablatedScores) {
  const deltas = fullScores.map((entry, index) => entry.recall - ablatedScores[index].recall);
  return {
    mean: rounded(mean(deltas)),
    median: rounded(median(deltas)),
    improvedCommits: deltas.filter((delta) => delta > 0).length,
    worsenedCommits: deltas.filter((delta) => delta < 0).length,
    unchangedCommits: deltas.filter((delta) => delta === 0).length,
  };
}

function predictionFor(db, origin, mode, edgeKinds) {
  const prediction = new Set(
    computeBlastRadius(db, origin, DEPTH_FOR_MODE(mode), edgeKinds)
      .map((node) => node.file)
  );
  if (mode === "implement") {
    for (const node of computeForwardDeps(db, origin)) prediction.add(node.file);
  }
  prediction.delete(origin);
  return prediction;
}

function benchmarkCommits(db, commits, graphFiles, trackedProjectFiles, root, crg) {
  const observations = [];
  for (const commit of commits) {
    const [origin, ...coChanged] = commit.files;
    const groundTruth = new Set(coChanged);
    const directory = path.posix.dirname(origin);
    const baselineDirectory = new Set(
      graphFiles.filter((file) => file !== origin && path.posix.dirname(file) === directory)
    );
    const baselineAll = new Set(graphFiles.filter((file) => file !== origin));

    observations.push({
      changedFiles: commit.files.length,
      headToHead: Object.fromEntries(COMPARISON_DEPTHS.map((depth) => {
        const prediction = new Set(computeBlastRadius(db, origin, depth).map((node) => node.file));
        prediction.delete(origin);
        return [depth, {
          tsReviewGraph: scoreForEvaluation(prediction, groundTruth, trackedProjectFiles).tracked,
          codeReviewGraph: scoreForEvaluation(
            crgPrediction(root, origin, depth, crg), groundTruth, trackedProjectFiles
          ).tracked,
        }];
      })),
      review: {
        full: scoreForEvaluation(
          predictionFor(db, origin, "review", undefined),
          groundTruth,
          trackedProjectFiles
        ),
        importsOnly: scoreForEvaluation(
          predictionFor(db, origin, "review", IMPORT_ONLY_EDGE_KINDS),
          groundTruth,
          trackedProjectFiles
        ),
      },
      implement: {
        full: scoreForEvaluation(
          predictionFor(db, origin, "implement", undefined),
          groundTruth,
          trackedProjectFiles
        ),
        importsOnly: scoreForEvaluation(
          predictionFor(db, origin, "implement", IMPORT_ONLY_EDGE_KINDS),
          groundTruth,
          trackedProjectFiles
        ),
      },
      baselines: {
        directory: scoreForEvaluation(
          baselineDirectory,
          groundTruth,
          trackedProjectFiles
        ),
        all: scoreForEvaluation(baselineAll, groundTruth, trackedProjectFiles),
      },
    });
  }
  return observations;
}

function summarizeObservations(observations) {
  const pairsFor = (selector) => observations.map(selector);
  const summarizePairs = (pairs) => ({
    ...summarizeScores(pairs.map((pair) => pair.tracked)),
    workingTree: summarizeScores(pairs.map((pair) => pair.workingTree)),
  });
  const reviewFull = pairsFor((entry) => entry.review.full);
  const reviewImportsOnly = pairsFor((entry) => entry.review.importsOnly);
  const implementFull = pairsFor((entry) => entry.implement.full);
  const implementImportsOnly = pairsFor((entry) => entry.implement.importsOnly);
  const summarizeDeltaPairs = (full, ablated) => ({
    ...summarizeRecallDelta(
      full.map((pair) => pair.tracked),
      ablated.map((pair) => pair.tracked)
    ),
    workingTree: summarizeRecallDelta(
      full.map((pair) => pair.workingTree),
      ablated.map((pair) => pair.workingTree)
    ),
  });
  return {
    eligibleCommits: observations.length,
    meanChangedFiles: rounded(mean(observations.map((entry) => entry.changedFiles))),
    headToHead: Object.fromEntries(COMPARISON_DEPTHS.map((depth) => {
      const tsScores = observations.map((entry) => entry.headToHead[depth].tsReviewGraph);
      const crgScores = observations.map((entry) => entry.headToHead[depth].codeReviewGraph);
      return [depth, {
        tsReviewGraph: summarizeScores(tsScores),
        codeReviewGraph: summarizeScores(crgScores),
        recallDelta: summarizeRecallDelta(tsScores, crgScores),
      }];
    })),
    modes: {
      review: {
        full: summarizePairs(reviewFull),
        importsOnly: summarizePairs(reviewImportsOnly),
        typeEdgeRecallDelta: summarizeDeltaPairs(reviewFull, reviewImportsOnly),
      },
      implement: {
        full: summarizePairs(implementFull),
        importsOnly: summarizePairs(implementImportsOnly),
        typeEdgeRecallDelta: summarizeDeltaPairs(implementFull, implementImportsOnly),
      },
    },
    baselines: {
      directory: summarizePairs(
        observations.map((entry) => entry.baselines.directory)
      ),
      all: summarizePairs(observations.map((entry) => entry.baselines.all)),
    },
  };
}

function isInside(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function isProjectSourceFile(root, filePath) {
  if (!isInside(root, filePath)) return false;
  const relative = path.relative(root, filePath);
  return !relative.split(path.sep).includes("node_modules");
}

function measureNonRelativeImports(root, tsconfigs) {
  const declarations = new Map();

  for (const tsconfig of tsconfigs) {
    const project = new Project({ tsConfigFilePath: tsconfig });
    for (const sourceFile of project.getSourceFiles()) {
      const sourcePath = sourceFile.getFilePath();
      if (!isProjectSourceFile(root, sourcePath)) continue;
      const sourceRelative = path.relative(root, sourcePath).split(path.sep).join("/");

      for (const declaration of sourceFile.getImportDeclarations()) {
        const key = `${sourceRelative}:${declaration.getStart()}`;
        const specifier = declaration.getModuleSpecifierValue();
        const existing = declarations.get(key) ?? {
          specifier,
          resolvedInsideProject: false,
        };
        const resolved = declaration.getModuleSpecifierSourceFile();
        if (resolved && isProjectSourceFile(root, resolved.getFilePath())) {
          existing.resolvedInsideProject = true;
        }
        declarations.set(key, existing);
      }
    }
  }

  const all = [...declarations.values()];
  const projectInternal = all.filter((entry) => entry.resolvedInsideProject);
  const nonRelativeProjectInternal = projectInternal.filter(
    (entry) => !entry.specifier.startsWith("./") && !entry.specifier.startsWith("../")
  );
  return {
    importDeclarations: all.length,
    resolvedProjectInternal: projectInternal.length,
    nonRelativeProjectInternal: nonRelativeProjectInternal.length,
    ratioAmongResolvedProjectInternal: rounded(
      projectInternal.length === 0
        ? null
        : nonRelativeProjectInternal.length / projectInternal.length
    ),
  };
}

function graphStats(db) {
  const { nodes } = db.prepare("SELECT COUNT(*) AS nodes FROM nodes").get();
  const { edges } = db.prepare("SELECT COUNT(*) AS edges FROM edges").get();
  const { files } = db.prepare("SELECT COUNT(*) AS files FROM file_hashes").get();
  return { nodes, edges, files };
}

function graphFiles(db) {
  return db.prepare(
    "SELECT file FROM file_hashes WHERE file LIKE '%.ts' OR file LIKE '%.tsx' ORDER BY file"
  ).all().map((row) => row.file);
}

function collectGraphInputFiles(root, tsconfigs) {
  const files = new Set();
  for (const tsconfig of tsconfigs) {
    const project = new Project({ tsConfigFilePath: tsconfig });
    for (const sourceFile of project.getSourceFiles()) {
      const sourcePath = sourceFile.getFilePath();
      if (!isProjectSourceFile(root, sourcePath)) continue;
      files.add(path.relative(root, sourcePath).split(path.sep).join("/"));
    }
  }
  return [...files].sort();
}

function digestGraphInputs(root, files, tsconfigs) {
  const configPath = path.join(root, ".ts-review-graph", "config.json");
  const absoluteInputs = [
    configPath,
    ...tsconfigs,
    ...files.map((file) => path.join(root, file)),
  ];
  const inputs = [...new Set(absoluteInputs)].sort();
  const hash = createHash("sha256");

  for (const input of inputs) {
    const relativePath = path.relative(root, input).split(path.sep).join("/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(input));
    hash.update("\0");
  }

  return hash.digest("hex");
}

function benchmarkRepository(repository, outDir, protectedRoots) {
  assertRepositoryUnchanged(repository.root);
  const startHead = runGit(repository.root, ["rev-parse", "HEAD"]);
  if (repository.expectedHead && startHead !== repository.expectedHead) {
    throw new Error(
      `${repository.name} の HEAD が固定 snapshot と一致しません: ${startHead}`
    );
  }
  const tsconfigs = readTsconfigs(repository.root);
  const fixedSnapshot = repository.expectedHead ?? startHead;
  const trackedProjectFiles = new Set(
    [...snapshotFiles(repository.root, fixedSnapshot)].filter((file) => /\.tsx?$/.test(file))
  );
  const graphInputFilesAtStart = collectGraphInputFiles(repository.root, tsconfigs);
  const graphInputDigestAtStart = digestGraphInputs(
    repository.root,
    graphInputFilesAtStart,
    tsconfigs
  );
  const dbPath = path.join(outDir, `${repository.name}.db`);
  assertSafeDatabasePath(dbPath, protectedRoots);
  process.stderr.write(`[構築] ${repository.name}: ${dbPath}\n`);
  const crg = buildCrg(repository, outDir, protectedRoots);
  const db = openDb(dbPath);
  let stats;
  let observations;
  let sourceFiles;
  let coverage;
  let workspaceImports;
  try {
    buildFullGraph(db, tsconfigs, repository.root);
    stats = graphStats(db);
    sourceFiles = graphFiles(db);
    const crgDb = new Database(path.join(crg.dataDir, "graph.db"), { readonly: true, fileMustExist: true });
    try {
      coverage = measureCoverage(db, crgDb, repository.root, trackedProjectFiles);
      workspaceImports = measureWorkspaceImports(db, crgDb, repository.root);
    } finally {
      crgDb.close();
    }
    const commits = eligibleCommits(repository.root, trackedProjectFiles);
    process.stderr.write(`[測定] ${repository.name}: ${commits.length} commits\n`);
    observations = benchmarkCommits(
      db,
      commits,
      sourceFiles,
      trackedProjectFiles,
      repository.root,
      crg
    );
  } finally {
    db.close();
  }

  const nonRelativeImports = measureNonRelativeImports(repository.root, tsconfigs);
  const graphInputFilesAtEnd = collectGraphInputFiles(repository.root, tsconfigs);
  const graphInputDigestAtEnd = digestGraphInputs(
    repository.root,
    graphInputFilesAtEnd,
    tsconfigs
  );
  if (
    graphInputDigestAtStart !== graphInputDigestAtEnd
    || JSON.stringify(graphInputFilesAtStart) !== JSON.stringify(graphInputFilesAtEnd)
  ) {
    throw new Error(`${repository.name} の graph 入力が測定中に変化しました`);
  }
  const untrackedGraphFiles = sourceFiles.filter(
    (file) => !trackedProjectFiles.has(file)
  );
  const endHead = runGit(repository.root, ["rev-parse", "HEAD"]);
  if (endHead !== startHead) {
    throw new Error(`${repository.name} の HEAD が測定中に変化しました: ${startHead} -> ${endHead}`);
  }

  assertRepositoryUnchanged(repository.root);

  return {
    result: {
      root: repository.root,
      snapshot: startHead,
      dbPath,
      tsconfigs: tsconfigs.map((tsconfig) => path.relative(repository.root, tsconfig)),
      graph: stats,
      coverage,
      workspaceImports,
      graphInputs: {
        sha256: graphInputDigestAtStart,
        untrackedFiles: untrackedGraphFiles,
      },
      ...summarizeObservations(observations),
      nonRelativeImports,
    },
    observations,
  };
}

function assertRepositoryUnchanged(root) {
  if (runGit(root, ["status", "--porcelain"]) !== "") {
    throw new Error(`対象 repository の working tree が clean ではありません: ${root}`);
  }
  if (lstatSync(path.join(root, ".code-review-graph"), { throwIfNoEntry: false })) {
    throw new Error(`対象 repository に .code-review-graph が存在します: ${root}`);
  }
}

function runCrg(args, crg, logName) {
  const stderrPath = path.join(crg.dataDir, logName);
  const stderrFd = openSync(stderrPath, "w");
  let stdout;
  try {
    stdout = execFileSync("uvx", ["--from", "code-review-graph==2.3.8", "code-review-graph", ...args], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, CRG_HOME: crg.home, CRG_PARSER_LOAD_TIMEOUT_SECONDS: "120" },
      stdio: ["ignore", "pipe", stderrFd],
    });
  } finally {
    closeSync(stderrFd);
    // stderr は省略せず scratch に保存し、成功扱いの parser skip も失敗にする。
    const stderr = readFileSync(stderrPath, "utf8");
    if (stderr.includes("Skipping unavailable tree-sitter parser")) {
      throw new Error(`Skipping unavailable tree-sitter parser を検出: ${stderrPath}\n${stderr}`);
    }
  }
  return stdout;
}

let crgVersion;
function buildCrg(repository, outDir, protectedRoots) {
  const crg = assertSafeCrgPaths(outDir, repository.name, protectedRoots);
  mkdirSync(crg.home, { recursive: true });
  mkdirSync(crg.dataDir, { recursive: true });
  const versionOutput = runCrg(["--version"], crg, "version.stderr.log").trim();
  const version = versionOutput.match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (version !== CRG_VERSION) throw new Error(`crg の版が一致しません: ${versionOutput}`);
  crgVersion = version;
  process.stderr.write(`[crg 構築] ${repository.name} (${version})\n`);
  runCrg(["build", "--repo", repository.root, "--data-dir", crg.dataDir], crg, "build.stderr.log");
  const db = new Database(path.join(crg.dataDir, "graph.db"), { readonly: true, fileMustExist: true });
  try {
    const { files } = db.prepare(
      "SELECT COUNT(*) AS files FROM nodes WHERE kind = 'File' AND (file_path LIKE '%.ts' OR file_path LIKE '%.tsx')"
    ).get();
    if (files === 0) throw new Error(`crg に TypeScript の File ノードがありません: ${repository.name}`);
  } finally {
    db.close();
  }
  return crg;
}

function crgPrediction(root, origin, depth, crg) {
  if (!origin) throw new Error("crg impact の origin が空です");
  const originPath = path.join(root, origin);
  const result = JSON.parse(runCrg([
    "impact", "--repo", root, "--files", originPath, "--depth", String(depth), "--max-results", "1000000",
  ], crg, "impact.stderr.log"));
  if (result.status !== "ok" || result.truncated !== false) {
    throw new Error(`crg impact が正常終了していません: ${JSON.stringify(result)}`);
  }
  if (!Array.isArray(result.changed_nodes) || !Array.isArray(result.impacted_files)) {
    throw new Error("crg impact の JSON が期待する配列を持ちません");
  }
  if (!result.changed_nodes.every((node) => node.file_path === originPath)) {
    throw new Error(`crg impact の起点が一致しません: ${originPath}`);
  }
  return new Set(result.impacted_files
    .filter((file) => isInside(root, file))
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .filter((file) => file !== origin)
    .sort());
}

function measureCoverage(db, crgDb, root, trackedFiles) {
  const tsFiles = new Set(db.prepare("SELECT file FROM nodes WHERE kind IN ('file', 'test')").all().map((row) => row.file));
  const crgFiles = new Set(crgDb.prepare("SELECT file_path FROM nodes WHERE kind = 'File'").all()
    .map((row) => path.relative(root, row.file_path).split(path.sep).join("/")));
  return {
    trackedFiles: trackedFiles.size,
    tsReviewGraph: [...trackedFiles].filter((file) => tsFiles.has(file)).length,
    codeReviewGraph: [...trackedFiles].filter((file) => crgFiles.has(file)).length,
  };
}

function workspacePackages(root) {
  // YAML の glob 解釈は pnpm に任せ、新しい YAML parser 依存を増やさない。
  if (existsSync(path.join(root, "pnpm-workspace.yaml"))) {
    const packages = JSON.parse(execFileSync("pnpm", ["--dir", root, "list", "--recursive", "--depth", "-1", "--json"], {
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    }));
    return {
      manifest: "pnpm-workspace.yaml",
      names: [...new Set(packages.filter((pkg) => path.resolve(pkg.path) !== root).map((pkg) => pkg.name))].sort(),
    };
  }
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
  if (!Array.isArray(patterns)) throw new Error(`workspace 定義がありません: ${root}`);
  const files = new Project().getFileSystem().globSync(patterns.map((pattern) => {
    const negative = pattern.startsWith("!");
    return `${negative ? "!" : ""}${path.join(root, negative ? pattern.slice(1) : pattern, "package.json")}`;
  }));
  return {
    manifest: "package.json#workspaces",
    names: [...new Set(files.map((file) => JSON.parse(readFileSync(file, "utf8")).name))].sort(),
  };
}

function measureWorkspaceImports(db, crgDb, root) {
  const packages = workspacePackages(root);
  if (packages.names.some((name) => typeof name !== "string" || name === "")) {
    throw new Error(`workspace package 名が不正です: ${root}`);
  }
  const unresolved = crgDb.prepare("SELECT file_path, target_qualified FROM edges WHERE kind = 'IMPORTS_FROM'").all()
    .filter((row) => /\.tsx?$/.test(row.file_path) && packages.names.some(
      (name) => row.target_qualified === name || row.target_qualified.startsWith(`${name}/`)
    ));
  const sources = new Set(unresolved.map((row) => path.relative(root, row.file_path).split(path.sep).join("/")));
  const resolved = db.prepare(`SELECT source.file AS source_file, target.file AS target_file
    FROM edges JOIN nodes source ON source.id = edges.source_id
    JOIN nodes target ON target.id = edges.target_id WHERE edges.kind = 'IMPORTS_FROM'`).all()
    .filter((row) => sources.has(row.source_file) && isProjectSourceFile(root, path.resolve(root, row.target_file)));
  return {
    ...packages,
    unresolvedCodeReviewGraph: unresolved.length,
    sourceFiles: sources.size,
    resolvedTsReviewGraph: resolved.length,
  };
}

function sumFields(key, fields) {
  return Object.fromEntries(fields.map((field) => [field,
    Object.values(repositoryResults).reduce((sum, result) => sum + result[key][field], 0),
  ]));
}

const { repositories, outDir } = parseArgs(process.argv.slice(2));
const protectedRoots = repositories.map((repository) => repository.root);
const userCrgHome = path.join(homedir(), ".code-review-graph");
protectedRoots.push(userCrgHome);
const safeOutDir = assertSafeOutputDirectory(outDir, protectedRoots);
for (const repository of repositories) {
  assertRepositoryUnchanged(repository.root);
  assertSafeCrgPaths(safeOutDir, repository.name, protectedRoots);
}
mkdirSync(safeOutDir, { recursive: true });

const repositoryResults = Object.create(null);
const allObservations = [];
for (const repository of repositories) {
  const { result, observations } = benchmarkRepository(repository, safeOutDir, protectedRoots);
  repositoryResults[repository.name] = result;
  allObservations.push(...observations);
}

const totalImports = Object.values(repositoryResults).reduce(
  (accumulator, result) => {
    accumulator.importDeclarations += result.nonRelativeImports.importDeclarations;
    accumulator.resolvedProjectInternal += result.nonRelativeImports.resolvedProjectInternal;
    accumulator.nonRelativeProjectInternal += result.nonRelativeImports.nonRelativeProjectInternal;
    return accumulator;
  },
  { importDeclarations: 0, resolvedProjectInternal: 0, nonRelativeProjectInternal: 0 }
);

const output = {
  schemaVersion: 2,
  codeReviewGraph: {
    version: crgVersion,
    depths: COMPARISON_DEPTHS,
    maxResults: 1000000,
    parserLoadTimeoutSeconds: 120,
    home: path.join(safeOutDir, "crg-home"),
  },
  filter: {
    nonMerge: true,
    since: SINCE,
    diffFilter: "AM",
    renames: false,
    extensions: [".ts", ".tsx"],
    changedFiles: { min: MIN_CHANGED_FILES, max: MAX_CHANGED_FILES },
    allFilesMustExistAtFixedSnapshot: true,
    originSelection: "lexicographically first path",
  },
  outDir: safeOutDir,
  repositories: repositoryResults,
  overall: {
    ...summarizeObservations(allObservations),
    coverage: sumFields("coverage", ["trackedFiles", "tsReviewGraph", "codeReviewGraph"]),
    workspaceImports: sumFields("workspaceImports", [
      "unresolvedCodeReviewGraph", "sourceFiles", "resolvedTsReviewGraph",
    ]),
    nonRelativeImports: {
      ...totalImports,
      ratioAmongResolvedProjectInternal: rounded(
        totalImports.resolvedProjectInternal === 0
          ? null
          : totalImports.nonRelativeProjectInternal / totalImports.resolvedProjectInternal
      ),
    },
  },
};

for (const repository of repositories) assertRepositoryUnchanged(repository.root);
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
