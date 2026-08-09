import { describe, it, expect } from "vitest";
import { toProjectRelative, toProjectAbsolute } from "../src/paths.js";

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
