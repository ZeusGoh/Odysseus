# Talking to the analysts

How to actually run the two-analyst read, and get it back into the app.

---

## The shape of it

```
                    ┌─ odysseus-stoch (process) ─┐
                    │  get_stoch_snapshot        │──→  stoch-analyst   ─┐
   node mcp/server  │  get_watchlist             │     (sees only this) │
                    └────────────────────────────┘                      ├─→ reconcile ─→ verdicts/*.json
                    ┌─ odysseus-news  (process) ─┐                      │        │
                    │  get_news_snapshot         │──→  news-analyst   ──┘        │
                    │  get_watchlist             │     (+ web search)            ↓
                    └────────────────────────────┘                    node mcp/publish.js
                                                                               ↓
                                                                    the app's Analyst view
```

**Two processes, not one.** A Claude Code subagent can only be restricted to a
whole MCP server, never to individual tools. So the only way the two analysts
stay genuinely blind to each other is for each one's data to be *absent from the
process it talks to*. That is what `--tools stoch` and `--tools news` are for.

---

## Setup — Claude Code (recommended)

Everything is already in the repo. From `C:\Users\ZeusG\Downloads\VL`:

```
claude
```

On first run it will ask whether to trust the project's `.mcp.json`. Say yes.
Then check both servers came up:

```
/mcp
```

You should see `odysseus-stoch` and `odysseus-news`, connected. If not:

```
node mcp/check.js --live
```

That tells you whether the problem is the server or the exchange.

### Use it

```
/read SOL
```

That runs both analysts in parallel, blind, reconciles them, writes
`verdicts/SOL-<timestamp>.json` and `verdicts/latest.json`, and gives you the
headline and the clashes in the chat.

You can also just talk to it:

> what do the analysts make of SUI?

> run the stoch analyst on ARB only — I don't care about the news side

> both analysts on everything in my watchlist, and tell me only where they clash

### Why not one analyst with both tools

Because it stops being two readings. A single model holding both payloads
anchors on whichever it read first and writes a summary that sounds like
confirmation. The whole value here is that two independent reads either converge
— which means something — or collide, which means something more useful.

---

## Setup — Claude Desktop

Claude Desktop has no subagents, so blindness costs you an extra step: you run
each analyst in its **own chat**, then reconcile in a third.

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "odysseus-stoch": {
      "command": "node",
      "args": ["C:\\Users\\ZeusG\\Downloads\\VL\\mcp\\server.js", "--tools", "stoch"]
    },
    "odysseus-news": {
      "command": "node",
      "args": ["C:\\Users\\ZeusG\\Downloads\\VL\\mcp\\server.js", "--tools", "news"]
    }
  }
}
```

Restart the app. Then:

1. New chat → paste the body of `.claude/agents/stoch-analyst.md` (everything
   below the `---` frontmatter) → ask for the read on your coin.
2. **New chat** → same with `.claude/agents/news-analyst.md`.
3. Third chat → paste both JSON blocks → paste the reconciliation section of
   `.claude/commands/read.md`.

Steps 1 and 2 must be separate chats. Two `/clear`s in the same conversation is
not the same thing.

---

## Getting it into the app

The app's **Analyst** view (Trading → Analyst) renders these reports. It does no
thinking: no API key, no model call, no tools. It validates and displays what it
was handed, and flags a report whose summary contradicts its own two analysts.

Two ways in:

**By hand** — open the view, drop `verdicts/latest.json` on it, or paste it.
Works offline, needs nothing set up.

**Through Cloud** — if you use the Cloud panel:

```
node mcp/publish.js verdicts/latest.json
```

It signs in with your Cloud account, merges the report into the same
`vl.analyst.v1` key the app syncs, and the report appears after the next sync.
Set `ODYSSEUS_CLOUD_EMAIL` to skip the email prompt; the password is asked for
and never written down.

```
node mcp/publish.js verdicts/latest.json --dry-run   # validate only
node mcp/publish.js verdicts/latest.json --print     # print the key, paste by hand
```

`publish.js` is deliberately **not** an MCP tool. The server stays read-only —
nothing a model can call from a chat can change the app's state. Publishing is a
command a person runs on purpose.

---

## Reading the output

**Agreement is computed from the two calls, not taken from the summary.** If a
reconciler writes "agree" over a bull and a bear, the view says so and tells you
to trust the two calls. Do.

| state | what it means |
|---|---|
| **agree** | Both reached the same call from different evidence. The strongest read this produces — and stronger still when the *reasons* differ. |
| **partial** | One has a call, the other is neutral. Half the evidence supports it. |
| **clash** | They disagree. This is the signal. |

The clashes worth knowing by shape:

- **stoch bull / news bear** — the indicator likes a setup riding a squeeze or an
  unexplained thin-book move. The backtest cannot see that the bid is forced.
  Usually a fade.
- **stoch bear / news bull** — a real catalyst against a stretched indicator. The
  historical record does not know about the catalyst. Small, or wait for the
  indicator to reset.
- **both neutral** — there is no trade. That is a result.

Reports older than six hours are dimmed and labelled. Structure and positioning
move faster than that.

---

## Unattended

Not built yet. The pieces are there: `--http` gives you a server a scheduled run
can reach without launching a subprocess, `mcp/client.js` is enough to drive the
tools from a script, and `publish.js` gets the result into the app. What is
missing is the runner that makes the two blind API calls and only notifies you
when the analysts clash sharply or both agree strongly.

That needs an Anthropic API key and a decision about where the server lives.
