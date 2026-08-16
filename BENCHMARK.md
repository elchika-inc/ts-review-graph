# ts-review-graph co-change recall ベンチマーク

- **測定日**: 2026-08-17
- **製品 baseline**: 0.5.5（`main` `b54771c`）
- **測定実装**: 本文と同じ repository revision の core / runner
- **主指標**: 過去の TypeScript 共変更ファイルに対する recall

## 結論

451件の適格 commit において、ts-review-graph の平均 recall は `review` モードで **41.12%**、`implement` モードで **55.27%** だった。同一 directory の全 TypeScript ファイルを返す `baseline-dir` の 19.28% より高い。一方、グラフ全体を返す `baseline-all` は recall 94.10% だが、precision は 0.85% だった。

型解決に関する2つの測定は、異なる結果になった。

- 型エッジ（`TYPED_BY` / `IMPLEMENTS` / `EXTENDS`）を除いた ablation では、**451件すべてで recall の低下が 0** だった。この co-change データセットは、型エッジの recall 寄与を支持しない。
- プロジェクト内へ解決できた import 1,862件のうち、`./` / `../` で始まらない non-relative specifier は **972件（52.20%）** だった。これは相対 specifier の文字列追跡だけでは不十分で、Compiler API と互換性のある module resolution が重要であることを支持する。

> **重要**: 型エッジ ablation は「型エッジを持たない」という一点に限って構文レベルのパーサを近似したものであり、`IMPORTS_FROM` 自体は Compiler API で解決している。code-review-graph そのものを実行した比較ではない。

## 測定対象

履歴フィルタの基準を固定するため、各リポジトリの commit SHA を次の snapshot に固定した。ベンチスクリプトは開始時と終了時に HEAD がこの SHA と一致することを検査する。グラフは対象リポジトリの read-only な working tree から構築するため、厳密な commit archive ではない。後述のとおり、評価時には予測集合と baseline を `git ls-tree -r <固定SHA> --name-only` に含まれるファイルへ絞り、絞る前の値も併記した。

| Repository | Snapshot | 適格 commit | 平均変更ファイル数 | Graph（nodes / edges / files） |
|---|---|---:|---:|---:|
| manako | `ad2cd3393cebb1f53e258b5ef2494780d736ba63` | 393 | 3.41 | 1,961 / 2,740 / 544 |
| todoke | `645eab2e824e9c1e53e325c4064c6236d8c53471` | 44 | 4.80 | 404 / 355 / 109 |
| miseru | `263de19dd9d4423427dffd54b6a9c9a7b012ea25` | 14 | 4.79 | 4,093 / 547 / 93 |
| **全体** | — | **451** | **3.59** | — |

## 方法

### Dataset

各リポジトリの Git 履歴に次の固定フィルタを適用した。このフィルタは結果を観測する前に固定しており、変更する場合はベンチ全体を新しい条件で再測定する。

1. 非 merge commit
2. `--since=2026-02-17`
3. `git show --no-renames --name-only --format= --diff-filter=AM <sha> -- '*.ts' '*.tsx'` の unique path が2〜10件
4. 抽出された path がすべて `git ls-tree -r <固定SHA> --name-only` に存在

変更ファイル集合を S、path の辞書順で先頭のファイルを起点 f、ground truth を G = S \ {f} とした。co-change は「共に変えることが多い」ことの代理指標であり、個々の commit の全ファイル間に依存関係があることを意味しない。

### Prediction

- `review`: `computeBlastRadius(db, f, DEPTH_FOR_MODE('review'))`
- `implement`: `computeBlastRadius(db, f, DEPTH_FOR_MODE('implement'))` と `computeForwardDeps(db, f)` の和集合
- どちらも予測集合 P から f 自身を除外
- ablation: `computeBlastRadius` の reverse traversal 用 `edgeKinds` に `['IMPORTS_FROM']` だけを指定。`computeBlastRadius` が別途加える `HAS_TEST` と、`implement` の FORWARD 計算は同じ

`recall = |P ∩ G| / |G|`、`precision = |P ∩ G| / |P|` とした。P が空の commit は precision の平均・中央値から除外し、件数を別途掲載する。全体値は451 commit を同じ重みで集計した。

### Baseline

- `baseline-dir`: f と同一 directory にある graph 内の全 `.ts` / `.tsx`（f を除外）
- `baseline-all`: graph 内の全 `.ts` / `.tsx`（f を除外）

通常の集計では、グラフ構築後に予測集合と baseline を対象の固定 SHA における commit 済み tree（`git ls-tree -r <固定SHA> --name-only`）へ絞った。これにより、working tree にだけ存在する生成物を ground truth と同じ固定 universe から除外する。絞る前の working-tree 集計との差分は「Working tree 入力の影響」に掲載する。

## co-change 結果

### ts-review-graph（通常の4 reverse edge kinds + HAS_TEST）

| Repository | Mode | Recall 平均 / 中央値 | Precision 平均 / 中央値 | Precision 除外 | 平均予測数 |
|---|---|---:|---:|---:|---:|
| manako | review | 43.76% / 33.33% | 15.52% / 1.69% | 68 | 26.39 |
| manako | implement | 57.72% / 60.00% | 9.38% / 2.02% | 26 | 42.74 |
| todoke | review | 26.94% / 0.00% | 18.82% / 9.09% | 7 | 4.18 |
| todoke | implement | 44.05% / 33.33% | 16.15% / 11.11% | 3 | 10.80 |
| miseru | review | 11.43% / 0.00% | 8.75% / 0.00% | 4 | 1.29 |
| miseru | implement | 21.79% / 8.33% | 16.71% / 10.00% | 1 | 6.50 |
| **全体** | **review** | **41.12% / 25.00%** | **15.66% / 1.69%** | **79** | **23.44** |
| **全体** | **implement** | **55.27% / 50.00%** | **10.26% / 2.90%** | **30** | **38.50** |

`implement` は直接 FORWARD import を追加するため recall が上がる一方、予測集合も大きくなり precision が下がった。

### `IMPORTS_FROM` reverse + HAS_TEST ablation

| Repository | Mode | Recall 平均 / 中央値 | Precision 平均 / 中央値 | Precision 除外 | Recall 差分平均 / 改善 commit |
|---|---|---:|---:|---:|---:|
| manako | review | 43.76% / 33.33% | 15.52% / 1.69% | 68 | 0.00pt / 0 |
| manako | implement | 57.72% / 60.00% | 9.38% / 2.02% | 26 | 0.00pt / 0 |
| todoke | review | 26.94% / 0.00% | 18.82% / 9.09% | 7 | 0.00pt / 0 |
| todoke | implement | 44.05% / 33.33% | 16.15% / 11.11% | 3 | 0.00pt / 0 |
| miseru | review | 11.43% / 0.00% | 8.75% / 0.00% | 4 | 0.00pt / 0 |
| miseru | implement | 21.79% / 8.33% | 16.71% / 10.00% | 1 | 0.00pt / 0 |
| **全体** | **review** | **41.12% / 25.00%** | **15.66% / 1.69%** | **79** | **0.00pt / 0** |
| **全体** | **implement** | **55.27% / 50.00%** | **10.26% / 2.90%** | **30** | **0.00pt / 0** |

通常版と ablation の recall はすべての commit で同じだった。manako `review` では通常版の平均予測数が 26.3868、ablation が 26.3791 で、型エッジによる追加予測はあったが ground truth には命中しなかった。他の repository / mode は予測数も同じだった。

> **比較の限界**: この ablation は「型エッジを持たない」という一点に限って構文レベルのパーサを近似したものであり、`IMPORTS_FROM` 自体は Compiler API で解決している。code-review-graph そのものを実行した比較ではない。

### Baseline

| Repository | Baseline | Recall 平均 / 中央値 | Precision 平均 / 中央値 | Precision 除外 | 平均予測数 |
|---|---|---:|---:|---:|---:|
| manako | directory | 20.07% / 0.00% | 8.74% / 0.00% | 34 | 12.25 |
| manako | all | 93.90% / 100.00% | 0.44% / 0.39% | 0 | 515.07 |
| todoke | directory | 15.97% / 0.00% | 11.67% / 0.00% | 2 | 7.05 |
| todoke | all | 94.27% / 100.00% | 3.44% / 2.91% | 0 | 103.05 |
| miseru | directory | 7.56% / 0.00% | 14.55% / 0.00% | 3 | 3.21 |
| miseru | all | 99.11% / 100.00% | 4.22% / 3.98% | 0 | 88.07 |
| **全体** | **directory** | **19.28% / 0.00%** | **9.19% / 0.00%** | **39** | **11.46** |
| **全体** | **all** | **94.10% / 100.00%** | **0.85% / 0.39%** | **0** | **461.61** |

## Working tree 入力の影響

グラフ入力に含まれた HEAD 外のファイルは6件だった。manako は0件、todoke は2件（`apps/landing/.astro/content.d.ts`、`apps/landing/.astro/types.d.ts`）、miseru は4件（`apps/api/worker-configuration.d.ts`、`apps/cleanup/worker-configuration.d.ts`、`apps/diff/worker-configuration.d.ts`、`apps/img/worker-configuration.d.ts`）である。

通常版、`IMPORTS_FROM` only ablation、`baseline-dir` は、tracked-file 絞り込み前後で全 repository / mode の recall、precision、予測数が同一だった。差が出たのは `baseline-all` の precision と予測数だけで、recall は同一だった。

| Repository | 評価 universe | Recall 平均 / 中央値 | Precision 平均 / 中央値 | 平均予測数 |
|---|---|---:|---:|---:|
| manako | tracked / working tree | 93.90% / 100.00% | 0.44% / 0.39% | 515.07 |
| todoke | tracked | 94.27% / 100.00% | 3.44% / 2.91% | 103.05 |
| todoke | working tree | 94.27% / 100.00% | 3.38% / 2.86% | 105.05 |
| miseru | tracked | 99.11% / 100.00% | 4.22% / 3.98% | 88.07 |
| miseru | working tree | 99.11% / 100.00% | 4.04% / 3.80% | 92.07 |
| **全体** | **tracked** | **94.10% / 100.00%** | **0.85% / 0.39%** | **461.61** |
| **全体** | **working tree** | **94.10% / 100.00%** | **0.84% / 0.39%** | **461.93** |

tracked-file 絞り込みによる `baseline-all` の差分は、todoke で平均 precision **+0.0655pt**・平均予測数 **-2.00**、miseru で **+0.1834pt**・**-4.00**、全体で **+0.0121pt**・**-0.3193** だった。manako と全 repository の recall 差分は 0 だった。

入力 digest（`.ts-review-graph/config.json`、tsconfig、graph 対象 `.ts` / `.tsx` の path と内容を SHA-256 化）は測定前後で一致することを runner が検査する。実測値は、manako `7896581f779de22e6c500559af01e0004482a8b01d4326943cf4f3b969b51045`、todoke `7388559caaa4cc4d35599fde544f309274ade9c28ffc11f68c6bee5b78de3229`、miseru `c43e73255d1d58ff87193551f3d8e05b193afbdd1fa3cc4d8b7b67008db18576` だった。

## non-relative module specifier

ts-morph で各 tsconfig の import declaration を走査し、`getModuleSpecifierSourceFile()` の解決先が repository 内にある import を分母とした。複数 tsconfig に同じ source が含まれる場合は `source path + declaration position` で重複排除した。

| Repository | Import declarations | 解決済みプロジェクト内 import | Non-relative | 比率 |
|---|---:|---:|---:|---:|
| manako | 2,358 | 1,506 | 743 | 49.34% |
| todoke | 358 | 181 | 71 | 39.23% |
| miseru | 300 | 175 | 158 | 90.29% |
| **全体** | **3,016** | **1,862** | **972** | **52.20%** |

走査元と解決先の path に `node_modules` segment を含む import はプロジェクト外依存として除外した。この比率は、プロジェクト内 import の過半数が相対 path の文字列追跡だけでは解決できず、Compiler API と互換性のある module resolution が必要であることを示す。ただし、個々の specifier が `paths`、`baseUrl`、package exports のいずれで解決されたかは分類していない。そのため、972件を `paths` / `baseUrl` の件数とは解釈できない。barrel re-export はこの主張に含めない。

## 再現手順

runner は `@elchika-inc/ts-review-graph-core` の build 済み entry point を直接 import し、MCP server を経由しない。対象 repository の `.ts-review-graph/config.json` は読み取るだけで、DB は対象 repository に書かない。

```bash
pnpm install --frozen-lockfile
pnpm build
node --test scripts/bench/safety.test.mjs
node scripts/bench/benchmark.mjs > /tmp/ts-review-graph-bench-run1.json
node scripts/bench/benchmark.mjs > /tmp/ts-review-graph-bench-run2.json
cmp /tmp/ts-review-graph-bench-run1.json /tmp/ts-review-graph-bench-run2.json
shasum -a 256 /tmp/ts-review-graph-bench-run1.json /tmp/ts-review-graph-bench-run2.json
```

scratch DB の既定出力先は `path.join(os.tmpdir(), "ts-review-graph-bench")` である。`TS_REVIEW_GRAPH_BENCH_OUT=/absolute/path` または `--out-dir /absolute/path` で変更できる。別の checkout を測るときは `--repo name=/absolute/path` を複数回指定する。

実測した2回の JSON は `cmp` exit 0 で一致し、SHA-256 はどちらも `098c615c27b0508a0ec28eeb52fe4677dac69a78e0a4ef2e0ac1a0528cf811b4` だった。

## 限界

- co-change はファイル依存の ground truth そのものではない。リファクタ、生成物、横断的な設定変更も共変更に含まれる。
- 起点は各 commit の辞書順先頭の1ファイルだけである。他の起点選択に対する感度分析は行っていない。
- 数値は上記3 repository / snapshot / tsconfig 構成に限定され、他言語や他プロジェクトへの一般化は検証していない。
- 以前のトークン削減ベンチは、現行版の機能とカバレッジを表さないため削除した。本測定はトークン数や作業時間を測っていない。
