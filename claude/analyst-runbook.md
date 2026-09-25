# Talking to the analysts

How to actually run the three-analyst read, and get it back into the app.

---

## The shape of it

```
                    ┌─ odysseus-stoch (process) ─┐
                    │  get_stoch_snapshot        │──→  stoch-analyst   ─┐
   node mcp/server  │  get_watchlist             │     (sees only this) │
                    └────────────────────────────┘                      ├─→ reconcile ─→ verdicts/*.json
                    ┌─ odysseus-news  (process) ─┐                      │        │
                    │  get_news_snapshot         │──→  news-analyst   ──┤        │
                    │  get_watchlist             │     (+ web search)   │        ↓
                    └────────────────────────────┘                      │  node mcp/publish.js
                    ┌─ odysseus-crowd (process) ─┐                      │        │
                    │  get_crowd_snapshot        │──→  crowd-analyst  ──┘        │
                    │  get_watchlist             │     (sees only this)          │
                    └────────────────────────────┘                               │
                                                                               ↓
                                                                    the app's Analyst view
```

**Three processes, not one.** A Claude Code subagent can only be restricted to a
whole MCP server, never to individual tools. So the only way the three analysts
stay genuinely blind to each other is for each one's data to be *absent from the
process it talks to*. That is what `--tools stoch`, `--tools news` and
`--tools crowd` are for.

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

You should see `odysseus-stoch`, `odysseus-news` and `odysseus-crowd`, connected. If not:

```
node mcp/check.js --live
```

That tells you whether the problem is the server or the exchange.

### Use it

```
/read SOL
```

That runs all three analysts in parallel, blind, reconciles them, writes
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
    },
    "odysseus-crowd": {
      "command": "node",
      "args": ["C:\\Users\\ZeusG\\Downloads\\VL\\mcp\\server.js", "--tools", "crowd"]
    }
  }
}
```

Restart the app. Then:

1. New chat → paste the body of `.claude/agents/stoch-analyst.md` (everything
   below the `---` frontmatter) → ask for the read on your coin.
2. **New chat** → same with `.claude/agents/news-analyst.md`.
3. **New chat** → same with `.claude/agents/crowd-analyst.md`.
4. Fourth chat → paste all three JSON blocks → paste the reconciliation section
   of `.claude/commands/read.md`.

Steps 1 to 3 must be separate chats. `/clear`s in the same conversation are
not the same thing.

---

## Getting it into the app

The app's **Analyst** view (Trading → Analyst) renders these reports. It does no
thinking: no API key, no model call, no tools. It validates and displays what it
was handed, and flags a report whose summary contradicts its own analysts.

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

`mcp/watch.js` runs the whole thing on a schedule, with no API key — it drives
Claude Code headlessly, so it uses your existing subscription.

```
node mcp/watch.js --dry-run     decide what is worth reading; spend nothing
node mcp/watch.js               one real pass
node mcp/watch.js --all         skip the gate and read everything
node mcp/watch.js --symbols SOL,SUI
```

### The gate, and why it exists

Fifteen coins every hour is ~720 subagent runs a day, nearly all of them
concluding that nothing changed. That is expensive and — worse — it teaches you
to ignore the output.

So each pass does the free part first. The engine recomputes the board and every
coin's indicator read using the app's own code and public exchange data: no model
call, no cost. A coin is handed to the analysts only when something actually
happened to it:

| trigger | fires when |
|---|---|
| **cross** | a fresh cross on 4H or slower, **and** the verdict engine grades it `playable` or `strong` on 20+ signals |
| **move** | a coin-specific move of 8%+ — a market-wide move never fires, however big |
| **volume** | one hour at 4x normal volume |
| **positioning** | a squeeze or a long flush, with crowded funding or a 10%+ open-interest swing |

Every threshold is in `WATCH_CFG` at the top of `watch.js`.

Each trigger carries a key naming the **event** — the bar the cross printed on,
the hour the move landed in — not the moment of looking. So a cross that stays
fresh for three hours is read once, not three times. Keys live in
`verdicts/.watch-state.json` and expire after a week. A read that fails is not
remembered, so it retries next hour instead of being silently swallowed.

A quiet pass costs nothing and logs one line per coin.

### Schedule it

Once, in a normal terminal:

```
schtasks /create /tn "Odysseus watch" /sc hourly /st 00:05 /f ^
  /tr "\"C:\Users\ZeusG\Downloads\VL\mcp\watch.cmd\""
```

Then, so reports reach the app without a password prompt, create
`%USERPROFILE%\.odysseus-cloud.json`:

```json
{ "email": "you@example.com", "password": "your cloud password" }
```

Outside the repo on purpose — it is your Cloud account, and it should never be
anywhere git can see it. `ODYSSEUS_CLOUD_EMAIL` / `ODYSSEUS_CLOUD_PASSWORD` work
too if you prefer environment variables.

Everything is appended to `verdicts\watch.log`. Check it after the first hour.

### Before the first scheduled run

1. Run `claude` interactively once in the project and approve the MCP servers.
2. `node mcp/watch.js --dry-run` — confirms the gate sees your board.
3. `node mcp/watch.js --symbols BTC --no-publish` — one real read, nothing pushed.
4. Then register the task.

If the log says `could not start "claude"`, Task Scheduler's PATH does not have
it. Run `where claude` in a normal terminal and put that path into
`ODYSSEUS_CLAUDE_BIN` in `watch.cmd`.

### What it does not do

It only runs while the laptop is on and awake — Task Scheduler cannot wake a
sleeping machine for this, and Claude Code needs your user session. An always-on
box would fix that, and is still the open hosting decision.
