import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptsRoot = path.join(repoRoot, "packages/plugin/hooks/scripts");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createHookFixture() {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "ts-review-graph-hooks-"));
  temporaryRoots.push(root);
  const physicalRoot = path.join(root, "physical");
  const logicalRoot = path.join(root, "logical project");
  const shimRoot = path.join(root, "bin");
  const capturePath = path.join(root, "npx-args.txt");

  mkdirSync(path.join(physicalRoot, "src"), { recursive: true });
  mkdirSync(path.join(physicalRoot, ".ts-review-graph"));
  mkdirSync(shimRoot);
  symlinkSync(physicalRoot, logicalRoot);
  writeFileSync(path.join(physicalRoot, "src/main.ts"), "export const value = 1;\n");
  writeFileSync(path.join(physicalRoot, ".ts-review-graph/graph.db"), "probe");

  const npxShim = path.join(shimRoot, "npx");
  writeFileSync(npxShim, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$NPX_CAPTURE"\n');
  chmodSync(npxShim, 0o755);

  const sqliteShim = path.join(shimRoot, "sqlite3");
  writeFileSync(
    sqliteShim,
    `#!/usr/bin/env bash
case "$*" in
  *sqlite_master*) printf '1\\n' ;;
  *"SELECT value FROM meta"*) printf '2\\n' ;;
  *) printf 'src/main.ts|changed\\n' ;;
esac
`
  );
  chmodSync(sqliteShim, 0o755);

  return { root, physicalRoot, logicalRoot, shimRoot, capturePath };
}

function runHook(
  hookName: "pre-read.sh" | "post-write.sh",
  fixture: ReturnType<typeof createHookFixture>,
  filePath: string
) {
  return spawnSync("bash", [path.join(scriptsRoot, hookName)], {
    cwd: fixture.logicalRoot,
    env: {
      ...process.env,
      PATH: `${fixture.shimRoot}:${process.env["PATH"] ?? ""}`,
      PWD: fixture.logicalRoot,
      NPX_CAPTURE: fixture.capturePath,
    },
    input: JSON.stringify({ tool_input: { file_path: filePath } }),
    encoding: "utf-8",
  });
}

describe("plugin hooks", () => {
  it.each(["logical", "physical"] as const)(
    "%s path を project 相対にして CLI へ渡す",
    (pathKind) => {
      const fixture = createHookFixture();
      const filePath = path.join(
        pathKind === "logical" ? fixture.logicalRoot : fixture.physicalRoot,
        "src/main.ts"
      );
      const result = runHook("post-write.sh", fixture, filePath);

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(fixture.capturePath, "utf-8").trim().split("\n")).toEqual([
        "-y",
        "@elchika-inc/ts-review-graph@0.5.1",
        "update",
        "src/main.ts",
        "--db",
        path.join(fixture.logicalRoot, ".ts-review-graph/graph.db"),
      ]);
    }
  );

  it.each(["logical", "physical"] as const)(
    "%s path からブラスト半径を照会する",
    (pathKind) => {
      const fixture = createHookFixture();
      const filePath = path.join(
        pathKind === "logical" ? fixture.logicalRoot : fixture.physicalRoot,
        "src/main.ts"
      );
      const result = runHook("pre-read.sh", fixture, filePath);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("[ts-review-graph] Blast radius for: src/main.ts");
      expect(result.stdout).toContain("src/main.ts  [changed]");
    }
  );

  it("plugin root に空白があっても両 hook command が script へ到達する", () => {
    const root = mkdtempSync(path.join(realpathSync(tmpdir()), "ts-review-graph-command-"));
    temporaryRoots.push(root);
    const pluginRoot = path.join(root, "plugin root");
    const fakeScriptsRoot = path.join(pluginRoot, "hooks/scripts");
    mkdirSync(fakeScriptsRoot, { recursive: true });
    writeFileSync(path.join(fakeScriptsRoot, "pre-read.sh"), "printf 'pre-read reached\\n'\n");
    writeFileSync(path.join(fakeScriptsRoot, "post-write.sh"), "printf 'post-write reached\\n'\n");

    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, "packages/plugin/hooks/hooks.json"), "utf-8")
    ) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const commands = [
      manifest.hooks.PreToolUse![0]!.hooks[0]!.command,
      manifest.hooks.PostToolUse![0]!.hooks[0]!.command,
    ];
    const results = commands.map((command) =>
      spawnSync("bash", ["-c", command], {
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
        encoding: "utf-8",
      })
    );

    expect(results.map((result) => result.status)).toEqual([0, 0]);
    expect(results.map((result) => result.stdout.trim())).toEqual([
      "pre-read reached",
      "post-write reached",
    ]);
  });
});
