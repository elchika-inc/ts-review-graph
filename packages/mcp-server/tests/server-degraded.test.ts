import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// server.ts の main() 配線（起動時に DB を開き、失敗理由を保持してツールへ渡す）を
// 実プロセスで固定する。unit テストは failure を手で注入するため、この経路だけは
// 実際にサーバーを起動しないと検証できない。
const serverPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/server.js"
);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = path.join(os.tmpdir(), `ts-rg-server-${randomUUID()}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

function callGraphStatus(cwd: string): Promise<{ text: string; isError: boolean; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // 親の TS_REVIEW_GRAPH_DB を継承すると外部 DB を触りうるので明示的に外す
      env: { ...process.env, TS_REVIEW_GRAPH_DB: undefined } as NodeJS.ProcessEnv,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout. stdout=${stdout} stderr=${stderr}`));
    }, 20000);

    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        let message: { id?: number; result?: { content?: { text: string }[]; isError?: boolean } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "graph_status", arguments: {} },
          });
        }
        if (message.id === 2) {
          clearTimeout(timer);
          child.kill("SIGTERM");
          resolve({
            text: message.result?.content?.[0]?.text ?? "",
            isError: message.result?.isError === true,
            stderr,
          });
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
  });
}

describe("MCP サーバー起動時の degraded 判定", () => {
  it("dist/server.js がビルド済みであること", () => {
    expect(existsSync(serverPath)).toBe(true);
  });

  it("DB ファイルが無ければ従来どおり「未構築」を返す", async () => {
    const result = await callGraphStatus(createRoot());

    expect(result.text).toContain("グラフ未構築");
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain("開けませんでした");
  });

  it("DB を開けなかったときは「未構築」と言わず理由を返す", async () => {
    const root = createRoot();
    mkdirSync(path.join(root, ".ts-review-graph"), { recursive: true });
    writeFileSync(path.join(root, ".ts-review-graph/graph.db"), "not a sqlite database\n");

    const result = await callGraphStatus(root);

    expect(result.text).not.toContain("グラフ未構築");
    expect(result.text).toContain("グラフ DB を開けませんでした");
    expect(result.text).toContain("file is not a database");
    expect(result.isError).toBe(true);
    // stderr の既存ログは残す（debug log へ流れる経路）
    expect(result.stderr).toContain("DB オープン失敗 — degraded mode で起動します");
  });
});
