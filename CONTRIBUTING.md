# Contributing to ts-review-graph

Thank you for your interest in contributing!

## Development Setup

**Requirements**: Node.js 20+, pnpm 9+

```bash
git clone https://github.com/elchika-inc/ts-review-graph.git
cd ts-review-graph
pnpm install
pnpm build
pnpm test
```

## Project Structure

```
packages/
  core/        — Graph build & query engine (SQLite + ts-morph)
  mcp-server/  — MCP server (8 tools)
  plugin/      — Claude Code plugin (commands/hooks/skills)
cli/           — CLI entry point
```

Key files:
- `packages/core/src/analyzer.ts` — AST analysis via TypeScript Compiler API
- `packages/core/src/blast.ts` — BFS blast radius (SQL recursive CTE)
- `packages/mcp-server/src/tools/index.ts` — MCP tool definitions
- `cli/src/index.ts` — CLI commands

## Commands

```bash
pnpm build       # Build all packages
pnpm test        # Run all tests (vitest)
pnpm lint        # Type-check all packages (tsc --noEmit)

# Single package
cd packages/core && pnpm build
cd packages/mcp-server && pnpm test
```

## Making Changes

1. Fork and create a branch: `git checkout -b feat/your-feature`
2. Make your changes with tests
3. Run `pnpm build && pnpm test && pnpm lint` — all must pass
4. Open a PR against `main`

## Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(scope): add new MCP tool
fix(core): handle circular imports in BFS
docs: update README examples
chore: bump dependencies
```

Scopes: `core`, `mcp-server`, `cli`, `plugin`

## Adding Tests

- Core tests: `packages/core/tests/`
- MCP integration tests: `packages/mcp-server/tests/`
- Tests use real SQLite (no mocks for DB layer)

## ESM Notes

All packages are `"type": "module"`. Import paths require `.js` extension even in TypeScript source:

```ts
import { openDb } from './db.js'
```

## Reporting Issues

Use [GitHub Issues](https://github.com/elchika-inc/ts-review-graph/issues) with the appropriate template.
