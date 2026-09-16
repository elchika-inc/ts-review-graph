# code-review-graph head-to-head ベンチマークレビュー記録

- 実施日: 2026-09-16
- 実装担当: Codex
- 対象: `scripts/bench/benchmark.mjs`、`scripts/bench/safety.mjs`、`scripts/bench/safety.test.mjs`、`BENCHMARK.md`、`README.md`
- 製品 baseline: `bc136afdfc47b7f4fcc4e8bcfcbe36ea75ba522f`（0.5.5）。製品ソースは変更しない。
- 成功基準: 下記 rubric 1〜8、指定 snapshot・フィルタの維持、7レンズのレビュー、PR 作成まで。マージは人間の判断に残す。
- 最大ラウンド数: 3
- レンズ: Fresh Eyes → Security → Core Logic → Tests → Domain → Ambiguity Hunter → Altitude Checker
- flag 判定: correctness・security・委任仕様の明示要件に影響し、確信度80%以上。optional は終了条件に数えない。

## 仕様照合と裁定

1. todoke に `pnpm-workspace.yaml` がなく、ルート `package.json#workspaces` に定義があることを確認し、司令塔へ照会した。回答に従い、YAML があれば pnpm の解釈、なければ `package.json#workspaces` を使い、採用元を repository ごとの JSON と文書に記録した。
2. ts-review-graph のテストファイルノードは `kind='test'` であることを照会した。司令塔の裁定に従い、カバレッジでは `file` と `test` を合わせて数えた。
3. 背景の todoke `@todoke` 未解決 import 83行に対し、本測定では28行だったため照会した。司令塔は背景の83行が全 scoped specifier の誤集計であったと確認し、`@todoke` で再集計した28行との一致を確認した。
4. depth 2 の平均 recall は ts-review-graph 41.55%、crg 43.60% だった。優位を支持しない結果もそのまま掲載する裁定を再確認した。
5. MCP `get_minimal_context` は `Graph not built` を返した。司令塔の承認を得て runner・schema の直接参照を行い、graph-assisted review を行ったとは扱わない。

## 実装上の裁量

- JSON は `schemaVersion: 2` とし、`headToHead`、`coverage`、`workspaceImports`、`codeReviewGraph` を追加した。
- 既存の採点関数を再利用し、`summarizeRecallDelta` に `worsenedCommits` を追加した。
- YAML の独自 parser や追加依存を作らず、`pnpm list --recursive --depth -1 --json` に workspace 解釈を任せる。package.json の glob は既存 ts-morph のファイルシステム API を使う。
- crg の stderr は子プロセスから scratch のファイルへ全量保存して検査する。版・build のログを残し、impact ログは最後の呼び出しのものを残す。
- crg 出力 subtree の既存 symlink と、利用者 home が未作成の場合も含む保護 path を検査する。

## 検証 rubric

### 1. ビルド・既存テスト・lint・安全性テスト

すべて独立したコマンドとして実行した。

| コマンド | 終了コード | 実測 |
|---|---:|---|
| `pnpm install --frozen-lockfile` | 0 | 199 packages、lockfile 変更なし |
| `pnpm build` | 0 | core / MCP server / CLI の build 完了 |
| `pnpm test` | 0 | 28 test files、307 tests（core 78、MCP 107、CLI 122）全件成功 |
| `pnpm lint` | 0 | core / MCP server / CLI の型チェック成功 |
| `node --test scripts/bench/safety.test.mjs` | 0 | 8 tests 成功、失敗・skip 0 |

変更前も既存テストは同じ307件であり、減少0件。安全性テストは6件から8件へ増加した。新しい crg path テストは実装前に export 未存在で exit 1 を確認し、実装後は保護対象内・home/data-dir/registry/WAL の symlink を拒否した。初回のテストは拒否メッセージを symlink に限定しすぎて失敗したため、既存の「repository の外側」検査による正しい拒否も受け入れるようアサーションを修正した。

### 2. 2回実行と決定性

- 各実行は manako 406、todoke 82、miseru 13、全体501 commit を測定し exit 0。
- 各実行で crg impact は501 commit × 2 depths = 1,002回。
- `cmp /tmp/ts-review-graph-bench-run1.json /tmp/ts-review-graph-bench-run2.json`: exit 0。
- 両 JSON の SHA-256: `7fd418ff884746cbbf4d17f714fee984b7164ce988bdf544043661cb0b638c22`。
- crg は CLI で2.3.8を確認。通常条件の parser skip、TS File0件、truncation、起点不一致は0件。

### 3. 沈黙失敗の self-test

`/tmp` の一時 Node preload で `execFileSync` の uvx 子 env だけを `CRG_PARSER_LOAD_TIMEOUT_SECONDS=0.001` に上書きし、別 scratch へ1回実行した。runner は `Error: Skipping unavailable tree-sitter parser を検出` と typescript parser timeout を報告し、exit 1 で停止した。JSON stdout は0 byte。一時 preload を削除し、恒久的な上書きオプションは追加していない。

### 4. 対象 repository の不変

測定前後に各 repository で `git status --porcelain` を実行し、3件とも exit 0・空出力だった。各 `<root>/.code-review-graph` への `ls -d` は前後とも exit 1・`No such file or directory` だった。runner 内でも repository ごとの前後・全体前後の検査と、HEAD / graph input digest の一致検査を通過した。

| Repository | 固定 HEAD |
|---|---|
| manako | `412df2b4a66b8afdc4d2c6619457bd15dcb393fa` |
| todoke | `59ee17770255d7963597c73c2c84e019d76def04` |
| miseru | `6aa3b7f0c8b91e687f6f7fa9303b5e9f5a9baeed` |

### 5. 利用者 home の不変

`~/.code-review-graph/registry.json` を前後に `cat` した。どちらも `{"repos": []}` の同じ整形 JSON であり、前後を保存したファイルの `cmp` は exit 0。

### 6. 文書と JSON の整合

| 項目 | run1 JSON | BENCHMARK.md / README.md |
|---|---:|---:|
| 全体 depth 2 ts-review-graph 平均 recall | 0.415485 | 41.55% |
| 全体 depth 2 crg 平均 recall | 0.435963 | 43.60% |
| 全体未解決 workspace import | 397 | 397行 |
| 適格 commit | 501 | 501 |

JSON から値を取り出し、文書表記との一致を assertion で検査して exit 0。両 recall の差分平均は -2.0478pt、改善3 / 悪化19 / 同値479 commit。depth 3 は 43.31% / 44.38%、差分 -1.0712pt、改善11 / 悪化20 / 同値470 commit。

### 7. 単一 snapshot

`BENCHMARK.md` / `README.md` に対する旧 snapshot の3検索はそれぞれ exit 1・0件。検索式の self-test として `git show main:BENCHMARK.md` の保存内容に対する同じ3検索はそれぞれ exit 0・1件だった。

```bash
grep -n "ad2cd3393" BENCHMARK.md README.md
grep -n "645eab2e8" BENCHMARK.md README.md
grep -n "263de19dd" BENCHMARK.md README.md
```

### 8. 所要時間・測定範囲

2回とも build と impact を逐次実行した。対象は上記3 repository の固定 snapshot で、製品ソース・version・co-change フィルタを変更せずに全体を再測定した。所要時間は終了時に記録する。

## 追加命中の読み取り専用診断

2回の測定後の同じ DB を readonly で開き、501 commit の depth 2 予測を再照合した（診断自体 exit 0）。crg のみの ground truth 命中は延べ23組、ts-review-graph のみは3組。crg の23組中20組が `.test.ts(x)` / `.spec.ts(x)`、13組は ts-review-graph のファイル集合に存在しない manako のファイル（テスト11組・実装2組）だった。todoke の7組はすべてテストだが ts-review-graph にも収録されていた。この内訳は BENCHMARK.md の結果節に記載した。

## レビューサイクル

独立レビュアーによる7レンズレビューを実施予定。終了結果を確認して追記する。

`INSPECTION_STATUS: PENDING`

## ACCEPTED_RISKS

- 既存 runner の Git quoted path の一般的な制約は残る。今回の3固定 tree では quoted path 0件であり、既知 path `package.json` が同じ一覧に存在することも確認した。掲載値への影響はない。
- crg と ts-review-graph の depth の意味・カバレッジは異なり、同じ探索量や recall 差の因果分解を保証しない。文書に条件を明記した。
