import { checkGraphHealth } from "@elchika-inc/ts-review-graph-core";
import type { Db } from "@elchika-inc/ts-review-graph-core";
import type { ToolResult } from "./types.js";
import { formatDbOpenFailureLines, type DbOpenFailure } from "./db-unavailable.js";

// dbFailure は既定値を持たせない — 渡し忘れると「オープン失敗」を「未構築」と誤報するため、
// 散文のルールではなく型で強制する。
export function graphStatus(
  db: Db | null,
  dbFailure: DbOpenFailure | null,
  projectRoot: string
): ToolResult {
  if (!db) {
    if (dbFailure) {
      return {
        content: [
          {
            type: "text",
            text: ["ts-review-graph status:", ...formatDbOpenFailureLines(dbFailure)].join("\n"),
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: "ts-review-graph status:\n  グラフ未構築 — build_graph ツールを呼び出してください",
        },
      ],
    };
  }

  try {
    const { nodeCount } = db
      .prepare("SELECT COUNT(*) as nodeCount FROM nodes")
      .get() as { nodeCount: number };
    const { edgeCount } = db
      .prepare("SELECT COUNT(*) as edgeCount FROM edges")
      .get() as { edgeCount: number };
    const { fileCount } = db
      .prepare("SELECT COUNT(*) as fileCount FROM file_hashes")
      .get() as { fileCount: number };
    const latest = db
      .prepare("SELECT MAX(updated_at) as t FROM file_hashes")
      .get() as { t: number | null };

    const updatedAt = latest.t
      ? new Date(latest.t).toISOString()
      : "未構築";

    return {
      content: [
        {
          type: "text",
          text: [
            `ts-review-graph status:`,
            `  nodes:      ${nodeCount}`,
            `  edges:      ${edgeCount}`,
            `  files:      ${fileCount}`,
            `  updated_at: ${updatedAt}`,
            `  health:     ${describeHealth(db, projectRoot)}`,
          ].join("\n"),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `グラフ情報の取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * 検疫の判定を表示する（拒否はしない）。
 *
 * graph_status は「他ツールを呼ぶ前に状態を確認する」ためのツールなので、
 * 他ツールが全滅する mismatch / stale を隠すと、唯一の診断口が「正常」と嘘をつく。
 * 判定自体が失敗しても表示に留める——診断ツールを診断で止めない。
 */
function describeHealth(db: Db, projectRoot: string): string {
  try {
    const health = checkGraphHealth(db, projectRoot);
    if (health.status === "ok") return "OK";
    if (health.status === "mismatch") return `MISMATCH (${health.reason}) — ${health.detail}`;
    return `STALE (${health.staleFiles}/${health.totalFiles} files changed)`;
  } catch (err) {
    return `判定できません: ${err instanceof Error ? err.message : String(err)}`;
  }
}
