# Claude Code フックの入力契約

## PreToolUse(Read)

- 実測日: 2026-08-09
- Claude Code: `2.1.226 (Claude Code)`
- 入力形式: argv とファイルパス用の `CLAUDE_*` 環境変数は空で、stdin に JSON が渡される
- ファイルパス: stdin JSON の `tool_input.file_path`
- shell での抽出式:

```bash
INPUT_JSON="$(cat)"
FILE_PATH="$(printf '%s' "$INPUT_JSON" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
```

`/tmp/hook-probe.log` で観測した該当部分:

```text
--- argv ---

--- env (CLAUDE_*) ---
CLAUDE_CODE_ENTRYPOINT=sdk-cli
CLAUDE_EFFORT=high
CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1
CLAUDE_CODE_CHILD_SESSION=1
CLAUDE_PID=16014
CLAUDE_PROJECT_DIR=/Users/nishikawa/orca/workspaces/ts-review-graph/graph-integrity-quarantine
CLAUDE_CODE_NO_FLICKER=1
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
CLAUDE_CODE_SESSION_ID=1732b3c1-ac20-428b-a2a3-f66a04c57dd7
--- stdin ---
{"session_id":"1732b3c1-ac20-428b-a2a3-f66a04c57dd7","transcript_path":"/Users/nishikawa/.claude/projects/-Users-nishikawa-orca-workspaces-ts-review-graph-graph-integrity-quarantine/1732b3c1-ac20-428b-a2a3-f66a04c57dd7.jsonl","cwd":"/Users/nishikawa/orca/workspaces/ts-review-graph/graph-integrity-quarantine","prompt_id":"cef34699-2070-4d25-b115-0661551956a1","permission_mode":"bypassPermissions","effort":{"level":"high"},"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/Users/nishikawa/orca/workspaces/ts-review-graph/graph-integrity-quarantine/package.json"},"tool_use_id":"toolu_01D1hjYNyaLRDcVfa8YssAtD"}
```
