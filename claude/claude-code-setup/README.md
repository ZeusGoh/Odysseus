# Claude Code setup files

These files belong in locations Claude cannot write to remotely — `.claude/`
and `.mcp.json` steer Claude itself, so the device bridge refuses to write them
on purpose. They live here so they are version-controlled, and get copied into
place by hand (once).

From the repo root, in PowerShell:

```powershell
New-Item -ItemType Directory -Force .claude\agents, .claude\commands | Out-Null
Copy-Item claude\claude-code-setup\stoch-analyst.md .claude\agents\
Copy-Item claude\claude-code-setup\news-analyst.md  .claude\agents\
Copy-Item claude\claude-code-setup\crowd-analyst.md .claude\agents\
Copy-Item claude\claude-code-setup\read.md          .claude\commands\
Copy-Item claude\claude-code-setup\mcp.json         .mcp.json
```

Or register the three servers with the CLI instead of copying `mcp.json`, which
writes the same file itself:

```
claude mcp add odysseus-stoch --scope project -- node ./mcp/server.js --tools stoch
claude mcp add odysseus-news  --scope project -- node ./mcp/server.js --tools news
claude mcp add odysseus-crowd --scope project -- node ./mcp/server.js --tools crowd
```

Then `claude`, trust the project when asked, and `/mcp` to confirm all three are
connected. `claude/analyst-runbook.md` is the how-to from there.

| file | goes to | what it is |
|---|---|---|
| `mcp.json` | `.mcp.json` | the three scoped server processes |
| `stoch-analyst.md` | `.claude/agents/` | the indicator analyst, granted only `mcp__odysseus-stoch` |
| `news-analyst.md` | `.claude/agents/` | the structural analyst, granted only `mcp__odysseus-news` + web search |
| `crowd-analyst.md` | `.claude/agents/` | the positioning analyst, granted only `mcp__odysseus-crowd` |
| `mcp-*.json` | (used by the relay) | one server each, for asking an analyst directly from the app |
| `read.md` | `.claude/commands/` | `/read SOL` — runs all three blind, reconciles, writes the report |

Keep editing the copies here and re-copying, rather than editing `.claude/`
directly — otherwise the version under git drifts from the one that runs.
