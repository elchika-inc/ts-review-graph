# ベンチマーク差別化レビュー記録

- 対象: `BENCHMARK.md`、`README.md`、`packages/core/src/blast.ts`、`packages/core/tests/blast.test.ts`、`scripts/bench/*.mjs`
- 実施日: 2026-08-17
- 最大ラウンド数: 3
- レンズ: Security、Core、Tests、Domain、Fresh、Ambiguity Hunter、Altitude Checker
- flag 判定: correctness・security・明示要件に影響し、確信度80%以上

## Round 1

### flag と対応

1. non-relative specifier の全件を `paths` / `baseUrl` の寄与として扱う記述は、package exports 等を分類していない実測からは言えない。
   - 対応: 主張を「相対 specifier の文字列追跡だけでは不十分で、Compiler API と互換性のある module resolution が重要」に限定し、解決機構を分類していない旨を両文書へ明記した。
2. `IMPORTS_FROM` only ablation も Compiler API で解決済みの import edge を使うため、「構文レベルのパーサの近似」だけでは近似範囲が曖昧だった。
   - 対応: 型エッジを持たない一点だけを近似し、`IMPORTS_FROM` 自体は Compiler API 解決済みであることを必須注記へ追記した。
3. 製品 baseline の `main` `b54771c` と、変更中の core / runner を同一の対象 version と読める記述だった。
   - 対応: 製品 baseline と測定実装を分離し、測定実装は文書と同じ repository revision であると明記した。
4. `--repo` の name に path traversal / object prototype key を指定でき、scratch DB の出力先に対象 repository 内や symlink 経由の内部 path を指定できた。
   - 対応: repository name の許可形式・予約名検査と、existing ancestor を実体解決する出力先検査を追加した。4件の Node test で path traversal、内部 path、symlink、正常系を固定した。
5. 固定 HEAD と説明しながら、グラフ構築は working tree の生成物を読むため厳密な HEAD snapshot ではなかった。
   - 対応: coordinator ruling に従い、履歴抽出の SHA 固定と read-only working-tree graph input を分離した。予測と baseline は tracked file に絞って評価し、絞り込み前の数値、除外6ファイル、差分、入力 digest を `BENCHMARK.md` に掲載した。

### optional

- README の version 固有表と BENCHMARK の重複縮小。
- 対象3 repository の選定理由の追記。

## Round 2

### flag と対応

1. repository 配下の `node_modules` をプロジェクト内解決先へ含め、non-relative 比率を過大集計していた。
   - 対応: 走査元と解決先の path に `node_modules` segment がある import を除外し、2回再測定した。全体値は1,862件中972件（52.20%）へ訂正した。
2. safe な出力 directory 内に `<repository>.db` symlink があると、対象 repository 内への書き込みを迂回できた。
   - 対応: DB、WAL、SHM、journal の leaf symlink を open 前に拒否し、回帰 test を追加した。
3. `TS_REVIEW_GRAPH_BENCH_OUT` の相対値を暗黙に絶対 path へ変換し、文書化した absolute-path 契約と不一致だった。
   - 対応: 環境変数と `--out-dir` を共通の絶対 path 検査へ通し、回帰 test を追加した。
4. `git ls-files` は index を読むため、固定 SHA の評価 universe になっていなかった。
   - 対応: coordinator の訂正 ruling に従い、適格 commit、予測集合、両 baseline の3箇所を `git ls-tree -r <固定SHA> --name-only` に統一した。件数は393 / 44 / 14のままだった。
5. グラフ構築、non-relative 走査、最後の digest 取得の間に working tree が変わっても HEAD 検査だけでは検出できなかった。
   - 対応: graph input の path 集合と内容 digest を測定前後に取得し、どちらかが変われば失敗させる検査を追加した。
6. ablation の説明が、`computeBlastRadius` が常に追加する `HAS_TEST` を明示していなかった。
   - 対応: 通常版を「4 reverse edge kinds + HAS_TEST」、ablation を「`IMPORTS_FROM` reverse + HAS_TEST」と記述し、`HAS_TEST` を維持する条件を両文書へ明記した。

Round 2 の早期 flag を修正している間も他レンズのレビューが進行していたため、Round 2 の報告には修正前後の観測が混在した。終了判定には使わず、全修正・再測定・検証後の固定 diff を Round 3 でクリーンレビューする。

### optional

- `edgeKinds=[]`、duplicate、ablation 時の `HAS_TEST` 維持を追加テストで固定する。
- case-insensitive filesystem 上の repository 名衝突と、改行を含む Git path の扱いを強化する。

## Round 3

Codex reviewer は全7 dispatch が account usage limit で完了不能になったため、同一 round の operational retry として Claude reviewer へ置き換えた。凍結 diff に対し7レンズを完走し、Core、Tests、Domain、Fresh は flag 0、Security、Ambiguity Hunter、Altitude Checker は次の残 flag を報告した。

1. Git の `core.quotePath` が既定のままなので、non-ASCII / 特殊 path を持つ別 repository の `--repo` 測定では Git の quoted path と DB の raw path が一致せず、recall を過小評価し得る。
   - 掲載値への影響: 対象3 repository の quoted path は0件と実測済みで、掲載値への影響はない。
2. `BENCHMARK.md` の既定再現手順は著者環境の絶対 path にある3 repository を前提とし、別環境では `--repo` 指定が必要であることを明示していない。
   - 掲載値への影響: 著者環境では文書どおり完走し、複数 reviewer が JSON SHA-256 まで再現した。第三者向けの前提開示が不足する。
3. README の見出し「0.5.5 co-change ベンチマーク」は、0.5.5 baseline に存在しない今回追加の `edgeKinds` API を使った ablation まで0.5.5へ帰属したように読める。
   - 掲載値への影響: BENCHMARK 本文では製品 baseline と測定実装を分離済みだが、README の見出しには同じ区別がない。

ユーザー指定の最大3ラウンドに到達したため、上記3件は追加ラウンドを開始せず打ち切り、PR 本文へ残件として記録する。

### optional

16件。主な内容は `edgeKinds=[]` / duplicate / `HAS_TEST` 維持の追加 test、statement cache key の順序依存、共有 tmp の TOCTOU、digest 対象に tsconfig `extends` 先や `package.json` が含まれない点、大文字 extension、環境依存の JSON hash、0件集計の明示、recall 上限と precision 除外内訳、README の言語混在・旧 graph 例である。終了条件外のため修正していない。

## 終了判定

`INSPECTION_STATUS: MAX_ROUNDS_REACHED; flag 3件をACCEPTED_RISKSへ記録; optional 16件`

- 残 flag: Git quoted path、既定再現手順のローカル path 前提、README の version 帰属。
- `ACCEPTED_RISKS`:
  - `AR-001`: Git quoted path は対象3 repository に存在せず、掲載値に影響しない。別 repository の `--repo` 測定では未解消。
  - `AR-002`: 既定再現手順は委任仕様で固定されたローカル3 repository を対象にする。別環境では `--repo` が必要だが、前提の明示不足は未解消。
  - `AR-003`: BENCHMARK の製品 baseline / 測定実装の区別は正しいが、README 見出しの version 帰属は未解消。
