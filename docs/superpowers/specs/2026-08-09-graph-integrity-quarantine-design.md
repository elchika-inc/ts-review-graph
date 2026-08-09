# グラフ整合性の検疫機構 — 設計書

- 日付: 2026-08-09
- 対象: `ts-review-graph` v0.4.0 → v0.5.0（破壊的スキーマ変更を含む）
- 目的: 導入したグラフが「腐っても気づけない」構造を除去し、ドッグフーディングに耐える状態にする

## 背景 — 実測で判明した障害

ドッグフーディング着手にあたり導入済みリポを調査した結果、以下を実測で確認した。

### 1. manako の導入が機能していなかった

`.mcp.json` に記録された DB パスが存在しないディレクトリを指していた。

```
.mcp.json の TS_REVIEW_GRAPH_DB
  → /Users/nishikawa/projects/naoto24kawa/manako/.ts-review-graph/graph.db
```

リポジトリが `naoto24kawa/` から `elchika-inc/` へ移動した際に取り残されたもの。
`cli/src/index.ts:161` が `install` 時に**絶対パスを `.mcp.json` へ書き込んでいる**のが原因。
`.mcp.json` は git 管理下のため、この絶対パスはコミットされ共有される。

一方 `packages/mcp-server/src/server.ts:18-20` の既定値は以下のとおりで、
MCP サーバーはプロジェクトルートを cwd として起動されるため、**env を書かなければ正しく解決される**。

```js
process.env["TS_REVIEW_GRAPH_DB"] ?? path.join(process.cwd(), ".ts-review-graph/graph.db")
```

つまりこの env の書き込みは、ポータビリティを壊す以外の効果を持たない。

なお MCP サーバー自体は `existsSync(DB_PATH)` ガード（`server.ts:29`）を持つため、
DB 不在時は「グラフ未構築」と報告する。この経路は沈黙していない。

### 2. DB に構築時の絶対パスが保存されている

```
sqlite> SELECT file FROM nodes LIMIT 1;
/Users/nishikawa/projects/naoto24kawa/manako/apps/admin/src/App.tsx
```

`packages/mcp-server/src/tools/resolve-path.ts` はクエリ時に「現在のプロジェクトルート基準の
絶対パス」を組み立てて照合するため、リポジトリの移動・worktree での作業・別マシンでのクローンにより
**全件が一致しなくなる**。この状態でも結果は「0 件」であり、エラーにはならない。

### 3. `pre-read.sh` フックが常に空振りしていた

`packages/plugin/hooks/scripts/pre-read.sh` を manako 上で実行した結果、
stdin JSON 方式・環境変数方式のいずれでも **exit 0 / 出力ゼロ**だった。

同スクリプトの SQL は edge kind に `CALLS` を含むが、実 DB に存在する kind は
`IMPORTS_FROM` / `TYPED_BY` / `EXTENDS` のみである。スキーマとフックの実装が乖離したまま
放置されていた。フックは `|| true` と「空なら exit 0」による fail-open のため、
乖離しても何も出力されず、気づく手段が存在しなかった。

### 4. `status` は壊れたグラフを健康と報告する

`cli/src/index.ts:341-392` と `packages/mcp-server/src/tools/graph-status.ts` は
`nodes` / `edges` / `files` の件数と `updated_at` を出力するのみで、
グラフが現在のリポジトリに対して引けるかどうかを一切判定しない。
manako のグラフは今も「nodes: 1191」と報告する。

## 問題の構造

腐敗が 3 層すべてで沈黙する。

| 層 | 現状 | 腐敗時の見え方 |
|---|---|---|
| DB スキーマ | 構築時の絶対パスを保存。構築条件を記録するテーブルが無い | 位置が変わると全件ミス → 0 件 |
| `status` / `graph_status` | 件数と時刻を出すのみ | 壊れていても健康に見える |
| `pre-read.sh` | fail-open（`\|\| true` + 空なら exit 0） | 常に沈黙 |

`file_hashes.updated_at` は保持されているにもかかわらず、「古い」という判定を行う箇所が存在しない。

## スコープ

含む:

- 位置依存の除去（相対パス保存）
- 沈黙の可視化（`meta` テーブル + 検疫 API）
- `pre-read.sh` の修復
- `install` が絶対パスを書き込まないようにする修正

含まない:

- 鮮度の自動維持（git hook / CI による自動再構築）— 別途検討
- 既存 DB のマイグレーションコード（後述のとおり不要）

## 設計

### § 1. スキーマ変更（破壊的・マイグレーション不要）

`graph.db` は `.gitignore` されたビルド成果物であり、各利用者が再構築できる。
したがって移行コードを書かず破壊的に変更する。

```sql
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

格納するキー:

| key | 値 | 用途 |
|---|---|---|
| `schema_version` | `"2"` | 旧形式 DB の検出 |
| `tsconfigs` | JSON 配列（ルート相対・ソート済み） | 設定ドリフトの検出 |
| `built_at` | epoch ms | 診断表示用（最終フルビルド時刻） |
| `built_root` | 構築時の絶対パス | **診断表示専用。判定には使わない** |

`schema_version` の初期値を `"2"` とするのは、`meta` を持たない現行 DB を暗黙の v1 と
みなすためである。`meta` 不在＝v1＝旧形式、という判定になる。

`nodes.file` および `file_hashes.file` は**プロジェクトルート相対の POSIX パス**で保存する。

`built_root` を判定に使わない理由: 相対パス化により DB は可搬になるため、
構築時と現在でルートが異なること自体は異常ではない。表示するのは
「なぜ壊れたか」を人間が読むためだけである。

### § 2. パス正規化の境界

**`nodes.id` も相対パス化の対象である。** `analyzer.ts` の `fileId(filePath)` /
`nodeId(filePath, name)` はファイルパスをそのまま id に埋め込んでおり、実 DB の id は
`/Users/.../apps/admin/src/App.tsx::App` の形をとる。`edges.source_id` / `edges.target_id`
はこの id を参照するため、`file` 列だけを相対化しても DB は可搬にならない。
**id 生成に渡すパスをルート相対に統一する**こと。

- 書き込み側（`analyzer.ts` / `updater.ts`）: 絶対パス → ルート相対に変換して保存する
  （`nodes.file` / `file_hashes.file` に加え、`fileId` / `nodeId` への入力も含む）
- 読み出し側（`blast.ts` / 各 MCP ツール）: 入力をルート相対に正規化してから照合する
- 出力: ルート相対のまま返す（現行の表示と同じ見た目になる）
- プロジェクトルートの導出: `dirname(DB_PATH)/..`（現行 `resolve-path.ts` と同一）
- `resolve-path.ts` の役割を「トラバーサル検証 + ルート相対化」に変更する。
  既存のパストラバーサル検証・シンボリックリンク検証は維持する。

### § 3. 検疫 API

`packages/core` に単一の関数を置き、CLI と MCP の両経路がこれを通る。

```ts
type GraphHealth =
  | { status: "ok" }
  | { status: "mismatch"; reason: "legacy_schema" | "tsconfig_drift"; detail: string }
  | { status: "drift"; staleFiles: number; totalFiles: number };

export function checkGraphHealth(db: Db, projectRoot: string): GraphHealth
```

判定は以下の順に行い、最初に該当したものを返す。

| # | 条件 | 判定 | 根拠 |
|---|---|---|---|
| 1 | `meta` テーブル不在、または `schema_version` が現行と不一致 | `mismatch: legacy_schema` | 旧形式 DB は絶対パスのまま。**既存の manako / todoke がここで自動的に捕まる** |
| 2 | `meta.tsconfigs` が `config.json` の内容と不一致 | `mismatch: tsconfig_drift` | グラフのスコープが設定とずれている |
| 3 | `file_hashes` の各行について `mtime > その行の updated_at` となるファイル数が 1 以上 | `drift` | ドリフトの実数。stat のみのため 1191 件でも数 ms |

判定 3 の比較対象を `meta.built_at`（全体の構築時刻）ではなく
**`file_hashes.updated_at`（ファイルごとの更新時刻）**とする理由:
`updater.ts` による増分更新は当該ファイルの `updated_at` のみを進め、
`meta.built_at` は据え置かれる。全体時刻と比較すると、増分更新済みのファイルまで
ドリフトとして数えてしまい、警告が恒常的に出続けることになる。

判定 3 で `file_hashes` に登録されているファイルがディスク上に存在しない場合
（stat が ENOENT）は、**`staleFiles` に数える**。削除されたファイルがグラフに
残っている状態はドリフトそのものである。

判定 2 で `config.json` が存在しない場合（現在の todoke がこの状態）は
`mismatch: tsconfig_drift`（detail に「`config.json` が見つかりません」）として
fail-closed に倒す。設定が無ければグラフのスコープを検証できず、
検証不能をゲート系で通すことはしない。

判定 1 により、マイグレーションコードを書かずに既存の全インストールを安全側へ倒せる。
「バージョンが記録されていない ＝ どの版か不明」は通常は扱いにくいが、
本件では「不明なら拒否」が正しい挙動であるため問題にならない。

#### 意図的な打ち切り（明示）

判定 3 はグラフに登録済みの既知ファイルのみを検査する。
**グラフ構築後に新規追加されたファイルは検知しない。** tsconfig の include を
glob する必要があり、フック経路で許容できないコストになるためである。

この穴を補うため、`get_minimal_context` は入力ファイルが `file_hashes` に
存在しない場合、以下を明示する。

```
NOT IN GRAPH: src/new-file.ts — グラフ構築後に追加された可能性があります
```

### § 4. 検疫ポリシー（fail-closed / fail-open の使い分け）

本ツールは `SKIP: 1170 other files — not in blast radius` と断言するため、
助言系ではなくゲート系として振る舞う。壊れたグラフが「読まなくてよい」と
言い切る害は、0 件を黙って返す害より大きい。

| 判定 | 挙動 |
|---|---|
| `mismatch` | **fail-closed**。結果を返さずエラーとし、`build_graph` の実行を促す |
| `drift` | **fail-open**。結果を返しつつ先頭に `⚠ STALE: N files changed since graph build (M total)` を併記 |
| `ok` | 通常どおり |

`mismatch` は客観的に壊れている状態のみを指す。`drift` は「1 ファイル編集しただけ」でも
発生するため、拒否すると実用性が失われる。

### § 5. 各経路への適用

| 経路 | 挙動 |
|---|---|
| MCP 各ツール | `mismatch` → `isError: true` で拒否 ／ `drift` → 結果先頭に警告行 |
| CLI `status` | `health:` 行を追加し `OK` / `MISMATCH(理由)` / `STALE(N/M)` を表示 |
| `pre-read.sh` | bash のまま。`meta.schema_version` を SQL で読み、不一致なら結果を出さず警告 1 行のみ出力 |

#### フックを Node 化しない判断（実測に基づく）

検疫ロジックを単一 API に集約する案を検討したが、フックは `npx` 経由でしか
CLI を起動できず、実測の結果として却下した。

| 方式 | 所要時間（実測） |
|---|---|
| `bash` + `sqlite3`（現行） | 0.00〜0.02 s |
| ローカル `node` dist CLI | 0.15 s（初回 0.43 s） |
| `npx -y @elchika-inc/ts-review-graph@latest` | **0.90 s（キャッシュ後）／初回 5.63 s** |

`hooks/hooks.json` の `timeout` は 5 秒であり、`npx` の初回起動 5.63 s はこれを超える。
また `@latest` 指定は毎回レジストリへ問い合わせるため、ネットワーク状況の影響を常に受ける。
`Read` のたびに発火するフックに 0.9 秒は許容できない。

結果として検疫ロジックは core（TypeScript）と フック（SQL）の 2 実装に分裂する。
この分裂そのものが `CALLS` の陳腐化を生んだ原因であるため、**乖離を検知するテスト**
（§ 7-5）を置いて補う。

### § 6. `install` の修正

```diff
  const serverEntry = {
    command: "npx",
    args: ["-y", "@elchika-inc/ts-review-graph-mcp-server"],
-   env: { TS_REVIEW_GRAPH_DB: dbPath },
  };
```

サーバー側の既定値 `process.cwd()/.ts-review-graph/graph.db` に委ねる。
加えて `install` 実行時、既存 `.mcp.json` の `ts-review-graph` エントリに
`env.TS_REVIEW_GRAPH_DB` が残っていれば除去する。

`--db` オプションで既定以外の場所を指定した場合のみ env を書き込む。
その場合はプロジェクトルートからの相対パスで書く。

### § 7. テスト

`packages/core` および `packages/mcp-server` に追加する。

1. **リポジトリ移動シミュレーション** — グラフを構築し、プロジェクトごと別ディレクトリへ
   コピーしたうえで同一クエリが同一結果を返すことを確認する（本障害の直接の回帰テスト）
2. 旧形式 DB（`meta` 不在）→ `mismatch: legacy_schema` を返す
3. `config.json` の tsconfig を 1 つ追加 → `mismatch: tsconfig_drift` を返す
4. グラフ構築後にファイルを touch → `drift: staleFiles = 1` を返す
5. **core とフックの乖離検知テスト** — フックが実装している検査は
   `schema_version` の一致のみであり、core の `checkGraphHealth` の部分集合である。
   したがって一致を検証する範囲を以下 2 点に限定する。
   - 旧形式のフィクスチャ DB に対し、`checkGraphHealth` が `legacy_schema` を返すとき、
     `pre-read.sh` もブラスト半径を出力しないこと
   - `pre-read.sh` の SQL に現れる edge kind の集合が `db.ts` の
     スキーマ定義（`IMPORTS_FROM` / `TYPED_BY` / `IMPLEMENTS` / `EXTENDS`）の
     部分集合であること（`CALLS` の陳腐化を再発させないための検査）
6. `get_minimal_context` に未登録ファイルを渡すと `NOT IN GRAPH:` を出力する

### § 8. 前提: プラグインは未インストールである

調査の結果、`packages/plugin` は**どの環境にもインストールされていない**ことを確認した。

```
manako/.claude/settings.local.json
  "enabledPlugins": {}                                 ← 空
  "enabledMcpjsonServers": [..., "ts-review-graph"]    ← MCP サーバーのみ

~/.claude/plugins/cache/naoto24kawa-claude-plugins/    → dev-tools のみ
```

CLI の `install` が配線するのは MCP サーバーと `CLAUDE.md` への追記のみであり、
`commands/` `hooks/` `skills/` を含むプラグインは別経路（marketplace 追加）で
導入する必要がある。したがって `pre-read.sh` は「空振りしていた」のではなく、
**発火経路が一度も存在しなかった**。

この事実により、フック関連の検証（DoneCriteria 6）は worktree 内の worker には
観測不能である。worker の担当範囲はフックスクリプトの修正と静的検証（§7-5）までとし、
実セッションでの発火確認は司令塔側の完了ゲートで行う。

プラグインの導入経路そのもの（ローカル marketplace として追加するか、
`install` にプラグイン登録を含めるか）は本設計の範囲外とし、
ドッグフーディング着手時に別途決定する。

### § 9. フック入力契約の確定（実装の最初のステップ）

`pre-read.sh` は `CLAUDE_TOOL_INPUT_FILE_PATH` を参照しているが、
stdin JSON 方式・環境変数方式のいずれでも出力が得られなかったため、
**現行 Claude Code が PreToolUse フックへ何を渡すかは未確定である**。

実装の最初のステップとして、フックへ渡される入力を実測して契約を確定し、
その結果に基づいて入力取得部を実装する。契約が確定するまで
`pre-read.sh` の他の修正（edge kind・相対パス化）は行わない。

## 完了基準（DoneCriteria）

以下をすべて実測で確認できた時点で完了とする。

1. `pnpm build` / `pnpm test` / `pnpm lint` がすべて成功する
2. 新規テスト 6 件（§ 7）がすべて成功する
3. ts-review-graph 自身に `install` を実行し、`get_minimal_context` が
   実際のファイルに対して非空の結果を返す
4. 3 の状態のプロジェクトを丸ごと別ディレクトリへコピーし、コピー先で同じクエリを
   実行して同一の結果が返る（元のディレクトリはリネームせず温存する）
5. `meta` テーブルを持たない旧形式 DB を配置した状態で MCP ツールを呼ぶと、
   結果ではなく `mismatch: legacy_schema` のエラーが返る
6. **（司令塔の完了ゲートで検証。worker の範囲外）** プラグインを導入した状態の
   実 Claude Code セッションで `pre-read.sh` が発火し、出力が観測できる。
   § 8 のとおり worker には観測不能なため、worker の DoneCriteria には含めない。

## 後続作業（本設計の範囲外）

- プラグイン導入経路の決定（ローカル marketplace 追加 / `install` への統合）

- ts-review-graph 自身への導入（ドッグフーディング本体）
- manako / todoke の再構築
- v0.5.0 として npm へ公開（現在 npm の latest は 0.3.5、ローカルは v0.4.0 が未公開）
- 鮮度の自動維持機構の検討
