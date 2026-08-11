import { describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hookPath = path.join(repoRoot, "packages/plugin/hooks/scripts/post-write.sh");

describe("post-write hook", () => {
  it("logical path を project 相対にして CLI へ渡す", () => {
    const physicalTmp = realpathSync(tmpdir());
    const physicalRoot = mkdtempSync(path.join(physicalTmp, "ts-review-graph-physical-"));
    const aliasRoot = mkdtempSync(path.join(physicalTmp, "ts-review-graph-alias-"));
    const logicalRoot = path.join(aliasRoot, "project");
    symlinkSync(physicalRoot, logicalRoot);

    mkdirSync(path.join(physicalRoot, "src"));
    mkdirSync(path.join(physicalRoot, ".ts-review-graph"));
    writeFileSync(path.join(physicalRoot, "src/main.ts"), "export const value = 1;\n");
    writeFileSync(path.join(physicalRoot, ".ts-review-graph/graph.db"), "probe");

    const shimRoot = mkdtempSync(path.join(physicalTmp, "ts-review-graph-shim-"));
    const capturePath = path.join(shimRoot, "npx-args.txt");
    const npxShim = path.join(shimRoot, "npx");
    writeFileSync(npxShim, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$NPX_CAPTURE"\n');
    chmodSync(npxShim, 0o755);

    const filePath = path.join(logicalRoot, "src/main.ts");
    const result = spawnSync("bash", [hookPath], {
      cwd: logicalRoot,
      env: {
        ...process.env,
        PATH: `${shimRoot}:${process.env["PATH"] ?? ""}`,
        PWD: logicalRoot,
        NPX_CAPTURE: capturePath,
      },
      input: JSON.stringify({ tool_input: { file_path: filePath } }),
      encoding: "utf-8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(capturePath, "utf-8").trim().split("\n")).toEqual([
      "-y",
      "@elchika-inc/ts-review-graph@0.5.1",
      "update",
      "src/main.ts",
      "--db",
      path.join(logicalRoot, ".ts-review-graph/graph.db"),
    ]);
  });
});
