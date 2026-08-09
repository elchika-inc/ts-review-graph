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

`/tmp/hook-probe.log` で観測した該当部分（ID とローカルパスは秘匿化済み）:

```text
--- argv ---

--- env (CLAUDE_*) ---
CLAUDE_CODE_ENTRYPOINT=sdk-cli
CLAUDE_EFFORT=high
CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1
CLAUDE_CODE_CHILD_SESSION=1
CLAUDE_PID=<redacted>
CLAUDE_PROJECT_DIR=/path/to/project
CLAUDE_CODE_NO_FLICKER=1
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
CLAUDE_CODE_SESSION_ID=<redacted>
--- stdin ---
{"session_id":"<redacted>","transcript_path":"<redacted>","cwd":"/path/to/project","prompt_id":"<redacted>","permission_mode":"<redacted>","effort":{"level":"high"},"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/path/to/project/package.json"},"tool_use_id":"<redacted>"}
```
