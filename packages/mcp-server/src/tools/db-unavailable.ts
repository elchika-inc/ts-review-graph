import { formatNpxAbiMismatchGuidance } from "@elchika-inc/ts-review-graph-core";

/** DB ファイルは存在したが openDb に失敗した理由。null は「そもそも DB ファイルが無い」を表す。 */
export interface DbOpenFailure {
  dbPath: string;
  message: string;
}

/** DB ファイル自体が無いときの文言。既存の利用者向けメッセージを変えない。 */
export const GRAPH_NOT_BUILT_TEXT =
  "Graph not built. Call build_graph first. / グラフが未構築です。まず build_graph ツールを呼び出してください。";

/**
 * オープン失敗を「未構築」と混同させないための説明行。
 * ABI 不一致なら CLI と同じ復旧手順（npx キャッシュ削除）を添える。
 */
export function formatDbOpenFailureLines(failure: DbOpenFailure): string[] {
  return [
    `✗ グラフ DB を開けませんでした（グラフは未構築ではありません）: ${failure.dbPath}`,
    `  理由: ${failure.message}`,
    ...formatNpxAbiMismatchGuidance(failure.message).map((line) => `  ${line}`),
    "  → 原因を解消したうえで、必要なら build_graph ツールでグラフを再構築してください。",
  ];
}

/** db=null のツール呼び出しへ返す本文。失敗理由があれば「未構築」とは言わない。 */
export function formatDbUnavailableText(failure: DbOpenFailure | null): string {
  if (!failure) return GRAPH_NOT_BUILT_TEXT;
  return formatDbOpenFailureLines(failure).join("\n");
}
