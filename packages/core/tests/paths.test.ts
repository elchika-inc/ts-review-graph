import { afterEach, describe, it, expect, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { toProjectRelative, toProjectAbsolute } from "../src/paths.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.mocked(realpathSync).mockClear();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createSymlinkFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ts-review-graph-paths-"));
  temporaryRoots.push(root);
  const physicalRoot = path.join(root, "physical");
  const logicalRoot = path.join(root, "logical");
  mkdirSync(path.join(physicalRoot, "src"), { recursive: true });
  writeFileSync(path.join(physicalRoot, "src/main.ts"), "export const value = 1;\n");
  symlinkSync(physicalRoot, logicalRoot);
  return { physicalRoot, logicalRoot };
}

describe("toProjectRelative", () => {
  it("ルート配下の絶対パスを相対 POSIX パスに変換する", () => {
    expect(toProjectRelative("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
  });

  it("既に相対パスならそのまま返す", () => {
    expect(toProjectRelative("/repo", "src/a.ts")).toBe("src/a.ts");
  });

  it("先頭に ./ を付けない", () => {
    expect(toProjectRelative("/repo", "/repo/a.ts")).toBe("a.ts");
  });

  it("末尾スラッシュ付きのルートでも動作する", () => {
    expect(toProjectRelative("/repo/", "/repo/src/a.ts")).toBe("src/a.ts");
  });

  it("ルート外の絶対パスは例外を投げる", () => {
    expect(() => toProjectRelative("/repo", "/other/a.ts")).toThrow(/outside project root/);
  });

  it("ルート外を指す相対パスは例外を投げる", () => {
    expect(() => toProjectRelative("/repo", "../outside.ts")).toThrow(/outside project root/);
  });

  it("ルート直下の .. で始まるファイル名は受け付ける", () => {
    expect(toProjectRelative("/repo", "/repo/..foo.ts")).toBe("..foo.ts");
  });

  it("物理 root と symlink 経由の論理 file path を同じプロジェクトとして扱う", () => {
    const { physicalRoot, logicalRoot } = createSymlinkFixture();

    expect(toProjectRelative(physicalRoot, path.join(logicalRoot, "src/main.ts"))).toBe(
      "src/main.ts"
    );
  });

  it("論理 root と実体 file path を同じプロジェクトとして扱う", () => {
    const { physicalRoot, logicalRoot } = createSymlinkFixture();

    expect(toProjectRelative(logicalRoot, path.join(physicalRoot, "src/main.ts"))).toBe(
      "src/main.ts"
    );
  });

  it("symlink 経由の存在しない file path は最も近い祖先を使って判定する", () => {
    const { physicalRoot, logicalRoot } = createSymlinkFixture();

    expect(toProjectRelative(physicalRoot, path.join(logicalRoot, "src/missing.ts"))).toBe(
      "src/missing.ts"
    );
  });

  it("symlink 経由でも実体がプロジェクトルート外なら拒否する", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ts-review-graph-paths-outside-"));
    temporaryRoots.push(root);
    const projectRoot = path.join(root, "project");
    const outsideRoot = path.join(root, "outside");
    const logicalOutside = path.join(root, "logical-outside");
    mkdirSync(projectRoot);
    mkdirSync(outsideRoot);
    writeFileSync(path.join(outsideRoot, "secret.ts"), "export const secret = 1;\n");
    symlinkSync(outsideRoot, logicalOutside);

    expect(() => toProjectRelative(projectRoot, path.join(logicalOutside, "secret.ts"))).toThrow(
      `Path is outside project root: ${path.join(logicalOutside, "secret.ts")}`
    );
  });

  it("realpathSync が失敗した場合は既存の例外で fail-closed にする", () => {
    vi.mocked(realpathSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });

    expect(() => toProjectRelative("/repo", "/other/a.ts")).toThrow(
      "Path is outside project root: /other/a.ts"
    );
  });

  it("通常経路では realpathSync を呼ばない", () => {
    vi.mocked(realpathSync).mockClear();

    expect(toProjectRelative("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(realpathSync).not.toHaveBeenCalled();
  });
});

describe("toProjectAbsolute", () => {
  it("相対パスを絶対パスに戻す", () => {
    expect(toProjectAbsolute("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
  });

  it("往復変換で元に戻る", () => {
    const abs = "/repo/packages/core/src/db.ts";
    expect(toProjectAbsolute("/repo", toProjectRelative("/repo", abs))).toBe(abs);
  });
});
