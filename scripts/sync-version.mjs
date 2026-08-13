import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

function readRequired(relativePath) {
  try {
    return readFileSync(path.join(repoRoot, relativePath), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`同期対象が見つかりません: ${relativePath}`);
    }
    throw new Error(`同期対象を読み込めません: ${relativePath}: ${error.message}`);
  }
}

function replaceExactly(content, pattern, replacement, relativePath, description) {
  const matches = content.match(pattern) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `想定形式が見つかりません: ${relativePath} (${description}, 検出数 ${matches.length})`
    );
  }
  return content.replace(pattern, replacement);
}

function packageVersionContent(relativePath, version) {
  return replaceExactly(
    readRequired(relativePath),
    /(\"version\"\s*:\s*\")[^\"]+(\")/g,
    `$1${version}$2`,
    relativePath,
    "version field"
  );
}

function collectUpdates(version) {
  const updates = new Map();

  for (const relativePath of [
    "packages/core/package.json",
    "packages/mcp-server/package.json",
    ".claude-plugin/marketplace.json",
    "packages/plugin/.claude-plugin/plugin.json",
  ]) {
    updates.set(relativePath, packageVersionContent(relativePath, version));
  }

  const pluginMcpPath = "packages/plugin/.mcp.json";
  updates.set(
    pluginMcpPath,
    replaceExactly(
      readRequired(pluginMcpPath),
      /(@elchika-inc\/ts-review-graph-mcp-server@)[^\"]+/g,
      `$1${version}`,
      pluginMcpPath,
      "MCP server package version"
    )
  );

  const postWritePath = "packages/plugin/hooks/scripts/post-write.sh";
  updates.set(
    postWritePath,
    replaceExactly(
      readRequired(postWritePath),
      /(@elchika-inc\/ts-review-graph@)[^\s]+(?=\s+update\b)/g,
      `$1${version}`,
      postWritePath,
      "CLI package version"
    )
  );

  const skillPath = "packages/plugin/skills/ts-review-graph/SKILL.md";
  const skillWithFrontmatter = replaceExactly(
    readRequired(skillPath),
    /^version:\s*\S+$/gm,
    `version: ${version}`,
    skillPath,
    "frontmatter version"
  );
  updates.set(
    skillPath,
    replaceExactly(
      skillWithFrontmatter,
      /(@elchika-inc\/ts-review-graph@)[^\s]+(?=\s+build\b)/g,
      `$1${version}`,
      skillPath,
      "CLI package version"
    )
  );

  return updates;
}

function main() {
  const cliPackagePath = "cli/package.json";
  const cliPackageText = readRequired(cliPackagePath);
  let cliPackage;
  try {
    cliPackage = JSON.parse(cliPackageText);
  } catch (error) {
    throw new Error(`想定形式が見つかりません: ${cliPackagePath} (${error.message})`);
  }
  const version = cliPackage.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`想定形式が見つかりません: ${cliPackagePath} (有効な version field)`);
  }

  const updates = collectUpdates(version);
  let changedCount = 0;
  for (const [relativePath, nextContent] of updates) {
    const currentContent = readRequired(relativePath);
    if (currentContent === nextContent) continue;
    writeFileSync(path.join(repoRoot, relativePath), nextContent);
    changedCount += 1;
  }

  console.log(`[sync-version] version ${version}: ${changedCount}件のファイルを更新`);
}

try {
  main();
} catch (error) {
  console.error(`[sync-version] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
