# ts-review-graph co-change recall ベンチマーク

- **測定日**: 2026-09-16
- **製品 baseline**: 0.5.5（`main` `bc136afdfc47b7f4fcc4e8bcfcbe36ea75ba522f`）
- **測定実装**: 本文と同じ repository revision の runner。製品 core は baseline から変更していない
- **比較対象**: code-review-graph 2.3.8（以下 crg）。CLI の `--version` でも一致を確認
- **主指標**: 過去の TypeScript 共変更ファイルに対する recall

## 結論

501件の適格 commit を同一 snapshot 上で評価した。reverse 走査 depth 2 の平均 recall は ts-review-graph **41.55%**、crg **43.60%**、差は **-2.05pt** だった。このデータセットでは crg が上回り、同深さ recall で ts-review-graph の優位を支持しなかった。precision・予測数・commit ごとの改善と悪化も下表に併記する。

製品の `review` / `implement` の平均 recall は **41.55% / 55.56%**、`baseline-dir` は 19.42% だった。`implement` は FORWARD 依存を足すので crg との主比較に使わない。

crg の未解決 workspace import は **397行**、その source 223ファイルから ts-review-graph がプロジェクト内へ解決した `IMPORTS_FROM` は **947エッジ** だった。後者は相対 import 等も含むため、前者をそのまま解決し直した件数ではない。カバレッジの違いと解決の違いは、別の観測として示す。

## 測定対象

履歴・評価 universe は次の固定 SHA の tree とし、開始時と終了時に HEAD 一致、`git status --porcelain` の空出力、対象内 `.code-review-graph` の不存在を検査する。グラフは read-only な working tree から構築するため厳密な commit archive ではない。予測は固定 SHA に存在する `.ts` / `.tsx` に絞って採点する。

| Repository | Snapshot | 適格 commit | 平均変更ファイル数 | ts-review-graph（nodes / edges / files） |
|---|---|---:|---:|---:|
| manako | `412df2b4a66b8afdc4d2c6619457bd15dcb393fa` | 406 | 3.41 | 2,160 / 2,935 / 562 |
| todoke | `59ee17770255d7963597c73c2c84e019d76def04` | 82 | 4.17 | 637 / 575 / 141 |
| miseru | `6aa3b7f0c8b91e687f6f7fa9303b5e9f5a9baeed` | 13 | 4.92 | 4,208 / 714 / 119 |
| 全体 | — | 501 | 3.57 | — |

## 方法

### Dataset

次のフィルタを維持した。条件を変更する場合はベンチ全体を再測定する。

1. 非 merge commit
2. `--since=2026-02-17`
3. `git show --no-renames --name-only --format= --diff-filter=AM <sha> -- '*.ts' '*.tsx'` の unique path が2〜10件
4. すべての抽出 path が `git ls-tree -r <固定SHA> --name-only` に存在

変更ファイル集合を S、辞書順先頭の1ファイルを起点 f、ground truth を G = S \ {f} とする。co-change は依存関係そのものではなく、共変更の代理指標である。

### Prediction と採点

- 製品 `review`: `computeBlastRadius(db, f, 2)`。
- 製品 `implement`: `computeBlastRadius(db, f, 3)` と `computeForwardDeps(db, f)` の和集合。
- 同深さ比較: `computeBlastRadius(db, f, 2)` / `computeBlastRadius(db, f, 3)`（`edgeKinds` は既定）と、crg `impact --depth 2` / `--depth 3`。
- 全予測で f を除外し、固定 SHA の `.ts` / `.tsx` へ絞り、sort した集合を採点する。
- 型エッジ ablation は reverse の `edgeKinds=['IMPORTS_FROM']`。別途追加される `HAS_TEST` と製品 `implement` の FORWARD 計算は維持する。

`recall = |P ∩ G| / |G|`、`precision = |P ∩ G| / |P|`。P が空なら precision の平均・中央値から除外し、その件数を記載する。全体値は501 commit を同じ重みで集計する。差分の符号は ts-review-graph − crg（ablation 表は通常版 − ablation）で、改善・悪化・同値は commit ごとの recall を比較する。

`baseline-dir` は f と同じ directory の graph 内 TypeScript ファイル、`baseline-all` は graph 内の全 TypeScript ファイルを返す。どちらも f を除外し、固定 SHA の tree に絞る。

## code-review-graph との head-to-head

同じ深さの reverse 走査を比較する。製品 `implement` の FORWARD 追加は含めない。crg の depth はノード間エッジ単位なので、深さの対応は名目上であり同じ探索量を保証しない。

| Repository | Depth | Tool | Recall 平均 / 中央値 | Precision 平均 / 中央値 | Precision 除外 | 平均予測数 | Recall 差分平均 / 改善 / 悪化 / 同値 commit |
|---|---:|---|---:|---:|---:|---:|---:|
| manako | 2 | ts-review-graph | 43.93% / 33.33% | 15.06% / 1.54% | 69 | 28.73 | -1.68pt / 3 / 12 / 391 |
| manako | 2 | crg | 45.60% / 38.75% | 17.39% / 1.56% | 53 | 25.53 | — |
| manako | 3 | ts-review-graph | 46.06% / 46.43% | 11.63% / 1.54% | 69 | 38.90 | -0.35pt / 11 / 12 / 383 |
| manako | 3 | crg | 46.41% / 50.00% | 15.05% / 1.54% | 53 | 29.90 | — |
| todoke | 2 | ts-review-graph | 35.14% / 18.75% | 12.80% / 9.09% | 15 | 8.76 | -4.21pt / 0 / 7 / 75 |
| todoke | 2 | crg | 39.35% / 26.79% | 13.54% / 9.09% | 15 | 9.34 | — |
| todoke | 3 | ts-review-graph | 35.38% / 22.50% | 10.42% / 9.09% | 15 | 10.49 | -4.82pt / 0 / 8 / 74 |
| todoke | 3 | crg | 40.20% / 26.79% | 11.02% / 9.09% | 15 | 11.16 | — |
| miseru | 2 | ts-review-graph | 7.69% / 0.00% | 5.56% / 0.00% | 4 | 0.77 | +0.00pt / 0 / 0 / 13 |
| miseru | 2 | crg | 7.69% / 0.00% | 5.56% / 0.00% | 4 | 0.77 | — |
| miseru | 3 | ts-review-graph | 7.69% / 0.00% | 5.56% / 0.00% | 4 | 0.77 | +0.00pt / 0 / 0 / 13 |
| miseru | 3 | crg | 7.69% / 0.00% | 5.56% / 0.00% | 4 | 0.77 | — |
| 全体 | 2 | ts-review-graph | 41.55% / 28.57% | 14.49% / 1.56% | 88 | 24.73 | -2.05pt / 3 / 19 / 479 |
| 全体 | 2 | crg | 43.60% / 33.33% | 16.54% / 1.56% | 72 | 22.24 | — |
| 全体 | 3 | ts-review-graph | 43.31% / 33.33% | 11.30% / 1.54% | 88 | 33.26 | -1.07pt / 11 / 20 / 470 |
| 全体 | 3 | crg | 44.38% / 33.33% | 14.22% / 1.56% | 72 | 26.07 | — |

### depth 2 の追加命中の内訳

同じ501 commit について予測集合と ground truth を再照合すると、crg だけが命中した共変更ファイルは延べ23件、ts-review-graph だけは延べ3件だった。ここで件数は commit × ファイルの組であり、同じファイルの別 commit での命中を別に数える。

| Repository | crg のみ命中 | うち `.test.ts(x)` / `.spec.ts(x)` | うち ts-review-graph グラフ収録外 | ts-review-graph のみ命中 |
|---|---:|---:|---:|---:|
| manako | 16 | 13 | 13 | 3 |
| todoke | 7 | 7 | 0 | 0 |
| miseru | 0 | 0 | 0 | 0 |
| 全体 | 23 | 20 | 13 | 3 |

manako のグラフ収録外13件はテスト11件と `apps/test-target-worker/src/routes/scenarios.ts` 2件で、カバレッジの違いが crg の追加命中に寄与した。例えば `apps/test-target-worker/src/routes/http.ts` 起点で `apps/test-target-worker/tests/http.test.ts` に命中した。todoke の7件は ts-review-graph にも収録済みのテストであり、カバレッジだけでは差を説明できない（例: `apps/api/src/index.ts` 起点の `apps/api/test/auth.test.ts`）。この観測だけから個々のエッジ種の因果効果は断定しない。

### カバレッジ

分母は固定 SHA の tree に存在する `.ts` / `.tsx`。ts-review-graph は `kind='file'` と `kind='test'` の両方をファイルノードとして数える。crg は `kind='File'` を数える。

| Repository | 固定 tree の TS/TSX | ts-review-graph | crg |
|---|---:|---:|---:|
| manako | 599 | 534 | 599 |
| todoke | 147 | 136 | 147 |
| miseru | 121 | 115 | 121 |
| 全体 | 867 | 785 | 867 |

### 未解決 workspace import

workspace 名は `pnpm-workspace.yaml` があれば pnpm の workspace 解釈を使い、なければルート `package.json` の `workspaces` から各 package の `name` を集める。名前の一覧と採用元は JSON に保存する。

crg の `IMPORTS_FROM` のうち source が TS/TSX で、`target_qualified` が workspace 名そのもの、または `<name>/` で始まる行を未解決として数える。同じ source ファイル集合から、ts-review-graph の `IMPORTS_FROM` がプロジェクト内ファイルノードへ解決したエッジを対置する。宣言の1対1照合ではなく、ts-review-graph 側には相対 import・re-export も含む。

| Repository | workspace 定義 | crg 未解決（行） | source（ファイル） | ts-review-graph 解決済み（エッジ） |
|---|---|---:|---:|---:|
| manako | pnpm-workspace.yaml | 284 | 160 | 715 |
| todoke | package.json#workspaces | 28 | 28 | 136 |
| miseru | pnpm-workspace.yaml | 85 | 35 | 96 |
| 全体 | — | 397 | 223 | 947 |

### crg の実行条件

版は **2.3.8** に固定する。runner は次の CLI を `execFileSync` で呼び、子プロセスの `CRG_HOME=<outDir>/crg-home` と `CRG_PARSER_LOAD_TIMEOUT_SECONDS=120` を必ず設定する。build は repository ごとに逐次実行し、flow / postprocess を省略しない。

```bash
CRG_HOME=<outDir>/crg-home CRG_PARSER_LOAD_TIMEOUT_SECONDS=120 uvx --from 'code-review-graph==2.3.8' code-review-graph --version
CRG_HOME=<outDir>/crg-home CRG_PARSER_LOAD_TIMEOUT_SECONDS=120 uvx --from 'code-review-graph==2.3.8' code-review-graph build --repo <root> --data-dir <outDir>/crg/<name>
CRG_HOME=<outDir>/crg-home CRG_PARSER_LOAD_TIMEOUT_SECONDS=120 uvx --from 'code-review-graph==2.3.8' code-review-graph impact --repo <root> --files <root>/<origin> --depth <2|3> --max-results 1000000
```

stderr を scratch に保存し、`Skipping unavailable tree-sitter parser` があれば成功扱いの build でも停止する。TS/TSX File ノード0件も停止条件とする。impact は空 origin を拒否し、`truncated === false`、`changed_nodes` の起点一致を毎回検査する。SQLite の参照は readonly で行う。

## co-change 結果（製品モード）

### 通常版（4 reverse edge kinds + HAS_TEST）

| Repository | Mode | Recall 平均 / 中央値 | Precision 平均 / 中央値 | Precision 除外 | 平均予測数 |
|---|---|---:|---:|---:|---:|
| manako | review | 43.93% / 33.33% | 15.06% / 1.54% | 69 | 28.73 |
| manako | implement | 57.82% / 63.33% | 9.18% / 1.90% | 30 | 46.19 |
| todoke | review | 35.14% / 18.75% | 12.80% / 9.09% | 15 | 8.76 |
| todoke | implement | 50.28% / 50.00% | 15.61% / 8.70% | 4 | 16.27 |
| miseru | review | 7.69% / 0.00% | 5.56% / 0.00% | 4 | 0.77 |
| miseru | implement | 18.30% / 0.00% | 15.97% / 0.00% | 1 | 7.69 |
| 全体 | review | 41.55% / 28.57% | 14.49% / 1.56% | 88 | 24.73 |
| 全体 | implement | 55.56% / 50.00% | 10.43% / 2.84% | 35 | 40.30 |

### `IMPORTS_FROM` reverse + HAS_TEST ablation

| Repository | Mode | Recall 平均 / 中央値 | Precision 平均 / 中央値 | Precision 除外 | 平均予測数 | Recall 差分平均 / 改善 / 悪化 / 同値 commit |
|---|---|---:|---:|---:|---:|---:|
| manako | review | 43.93% / 33.33% | 15.06% / 1.54% | 69 | 28.72 | +0.00pt / 0 / 0 / 406 |
| manako | implement | 57.82% / 63.33% | 9.18% / 1.90% | 30 | 46.19 | +0.00pt / 0 / 0 / 406 |
| todoke | review | 35.14% / 18.75% | 12.80% / 9.09% | 15 | 8.76 | +0.00pt / 0 / 0 / 82 |
| todoke | implement | 50.28% / 50.00% | 15.61% / 8.70% | 4 | 16.27 | +0.00pt / 0 / 0 / 82 |
| miseru | review | 7.69% / 0.00% | 5.56% / 0.00% | 4 | 0.77 | +0.00pt / 0 / 0 / 13 |
| miseru | implement | 18.30% / 0.00% | 15.97% / 0.00% | 1 | 7.69 | +0.00pt / 0 / 0 / 13 |
| 全体 | review | 41.55% / 28.57% | 14.49% / 1.56% | 88 | 24.73 | +0.00pt / 0 / 0 / 501 |
| 全体 | implement | 55.56% / 50.00% | 10.43% / 2.84% | 35 | 40.30 | +0.00pt / 0 / 0 / 501 |

この ablation の `IMPORTS_FROM` は Compiler API 解決済みであり、crg 本体の代用ではない。上の head-to-head は crg 本体を別途実行した値である。型エッジの寄与は ablation 表の差分が示す範囲に限って解釈する。

### Baseline

| Repository | Baseline | Recall 平均 / 中央値 | Precision 平均 / 中央値 | Precision 除外 | 平均予測数 |
|---|---|---:|---:|---:|---:|
| manako | directory | 19.77% / 0.00% | 8.58% / 0.00% | 38 | 12.18 |
| manako | all | 93.36% / 100.00% | 0.43% / 0.38% | 0 | 533.07 |
| todoke | directory | 20.04% / 0.00% | 9.61% / 0.00% | 4 | 10.50 |
| todoke | all | 96.32% / 100.00% | 2.23% / 2.22% | 0 | 135.02 |
| miseru | directory | 4.70% / 0.00% | 11.00% / 0.00% | 3 | 3.62 |
| miseru | all | 99.04% / 100.00% | 3.37% / 1.75% | 0 | 114.08 |
| 全体 | directory | 19.42% / 0.00% | 8.81% / 0.00% | 45 | 11.68 |
| 全体 | all | 93.99% / 100.00% | 0.80% / 0.38% | 0 | 457.05 |

## Working tree 入力の影響

グラフ入力のうち固定 SHA の tree にない TS/TSX は次のとおり。入力 digest は `.ts-review-graph/config.json`、指定 tsconfig、グラフ対象ソースの path と内容から SHA-256 を算出し、測定前後で入力集合と digest の一致を検査する。

| Repository | tree 外ファイル | 入力 SHA-256 |
|---|---|---|
| manako | なし | `d87a710e416aada6a4f742177d102f6328bca616ed0b120d83679ec9e5d095af` |
| todoke | `apps/landing/.astro/content.d.ts`、`apps/landing/.astro/types.d.ts` | `ac7acc8012c8dfa1cb9c791a2261e9a9bffb1b0f422b7d103b08706839126ac0` |
| miseru | `apps/api/worker-configuration.d.ts`、`apps/cleanup/worker-configuration.d.ts`、`apps/diff/worker-configuration.d.ts`、`apps/img/worker-configuration.d.ts` | `7c3142d402459707935ef2c77ae941f1f11d7241f50d79fad882cb127db61452` |

tracked 絞り込み前後の値は JSON の各 `workingTree` に残す。以下は `baseline-all` の比較である。

| Repository | 評価 universe | Recall 平均 / 中央値 | Precision 平均 / 中央値 | Precision 除外 | 平均予測数 |
|---|---|---:|---:|---:|---:|
| manako | tracked | 93.36% / 100.00% | 0.43% / 0.38% | 0 | 533.07 |
| manako | working tree | 93.36% / 100.00% | 0.43% / 0.38% | 0 | 533.07 |
| todoke | tracked | 96.32% / 100.00% | 2.23% / 2.22% | 0 | 135.02 |
| todoke | working tree | 96.32% / 100.00% | 2.20% / 2.19% | 0 | 137.02 |
| miseru | tracked | 99.04% / 100.00% | 3.37% / 1.75% | 0 | 114.08 |
| miseru | working tree | 99.04% / 100.00% | 3.26% / 1.69% | 0 | 118.08 |
| 全体 | tracked | 93.99% / 100.00% | 0.80% / 0.38% | 0 | 457.05 |
| 全体 | working tree | 93.99% / 100.00% | 0.79% / 0.38% | 0 | 457.48 |

その他の製品モード・ablation・directory baseline で tracked 絞り込みにより変わった集計値は次のとおり（tracked − working tree）。

- manako implement/full meanPrecision: 0.091845 − 0.09169。
- manako implement/full meanPredictedFiles: 46.192118 − 46.261084。
- manako implement/importsOnly meanPrecision: 0.091845 − 0.09169。
- manako implement/importsOnly meanPredictedFiles: 46.192118 − 46.261084。
- 全体 implement/full meanPrecision: 0.104348 − 0.104223。
- 全体 implement/full medianPrecision: 0.02837 − 0.028169。
- 全体 implement/full meanPredictedFiles: 40.295409 − 40.351297。
- 全体 implement/importsOnly meanPrecision: 0.104348 − 0.104223。
- 全体 implement/importsOnly medianPrecision: 0.02837 − 0.028169。
- 全体 implement/importsOnly meanPredictedFiles: 40.295409 − 40.351297。

## non-relative module specifier

ts-morph で各 tsconfig の import declaration を走査し、`getModuleSpecifierSourceFile()` が repository 内へ解決したものを分母とする。`source path + declaration position` で重複排除し、source / target に `node_modules` segment があるものを除外する。

| Repository | Import declarations | 解決済みプロジェクト内 import | Non-relative | 比率 |
|---|---:|---:|---:|---:|
| manako | 2,486 | 1,587 | 755 | 47.57% |
| todoke | 591 | 275 | 79 | 28.73% |
| miseru | 431 | 262 | 231 | 88.17% |
| 全体 | 3,508 | 2,124 | 1,065 | 50.14% |

この比率は相対 specifier の文字列追跡だけでは解決できない import の存在を示す。`paths` / `baseUrl` / package exports の内訳は分類しておらず、non-relative 全件を特定の解決機構の寄与とは解釈しない。barrel re-export はこの集計に含めない。

## 再現手順

Node.js・pnpm・uv（`uvx`）と対象3 repository の依存関係が必要。既定 path は著者環境の `/Users/nishikawa/projects/elchika-inc/{manako,todoke,miseru}`。別環境では同じ snapshot の checkout を用意し、各実行へ `--repo manako=/absolute/path --repo todoke=/absolute/path --repo miseru=/absolute/path` を追加する（`--repo` は開始時 HEAD を snapshot に採用するため上表の SHA を事前に確認する）。

runner は build 済み core entry point を直接 import し、対象の config と working tree は読むだけである。crg の取得・版確認も scratch の `CRG_HOME` で行う。

```bash
pnpm install --frozen-lockfile
pnpm build
CRG_HOME=/tmp/ts-review-graph-crg-version CRG_PARSER_LOAD_TIMEOUT_SECONDS=120 uvx --from 'code-review-graph==2.3.8' code-review-graph --version
node --test scripts/bench/safety.test.mjs
node scripts/bench/benchmark.mjs > /tmp/ts-review-graph-bench-run1.json
node scripts/bench/benchmark.mjs > /tmp/ts-review-graph-bench-run2.json
cmp /tmp/ts-review-graph-bench-run1.json /tmp/ts-review-graph-bench-run2.json
shasum -a 256 /tmp/ts-review-graph-bench-run1.json /tmp/ts-review-graph-bench-run2.json
```

既定出力先は `path.join(os.tmpdir(), "ts-review-graph-bench")`。`TS_REVIEW_GRAPH_BENCH_OUT` / `--out-dir` で絶対 path を指定できる。crg は `<outDir>/crg-home` に registry、`<outDir>/crg/<name>` に DB・stderr を保存する。対象 repository と利用者の `~/.code-review-graph` は保護対象とし、crg 出力 subtree の symlink も拒否する。同一 outDir で並行実行しない。

JSON は schemaVersion 2。2回の実行は `cmp` exit 0 で一致し、SHA-256 は `7fd418ff884746cbbf4d17f714fee984b7164ce988bdf544043661cb0b638c22`。絶対 path と入力 digest を含むため別環境の JSON hash は一致するとは限らない。

## 限界

- co-change は依存の ground truth そのものではない。リファクタ、生成物、横断的な変更も含む。
- 起点は各 commit の辞書順先頭1ファイル。起点の感度分析は行っていない。
- crg の depth はノード単位の `CALLS` / `REFERENCES` / `TESTED_BY` 等を跨ぐ。ts-review-graph と深さの対応は名目上であり、同じ探索量や辺の意味を保証しない。
- crg は tsconfig の include 外も走査する。カバレッジと module resolution の影響を別々に介入して再測定しておらず、recall 差を一方だけの因果効果とは断定しない。
- 未解決 workspace import は crg の辺の行数、対置する ts-review-graph は同じ source 集合からの全プロジェクト内 import エッジ数であり、同じ import 宣言だけの成功率ではない。
- グラフ入力は working tree。input digest は指定 tsconfig・graph ソース等に限定し、全依存 package の内容まで固定していない。
- Git quoted path の一般的な扱いは既存 runner の制約が残る。対象3 snapshot の掲載測定では quoted path が0件であることを検査した。
- この3 repository / snapshot / tsconfig 構成に限った結果であり、他言語や他プロジェクトへの一般化は検証していない。トークン削減・実作業時間の比較は測定していない。
- 起点は各 commit の辞書順先頭のファイルなので `apps/*` に偏る。`packages/*` 配下が起点となる commit は manako 21・todoke 1・miseru 0 の計 22 件（司令塔が同じ履歴フィルタで数えた概算。固定 SHA の tree 存在チェックを省いた母集団 699 件に対する値で、掲載の 501 件を分母にしても 22 件を超えない）。共有パッケージを起点にした比較はほぼ含まれず、workspace import 解決の差が recall に現れにくい設計になっている。
