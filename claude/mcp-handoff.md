# Odysseus MCP — continuation prompt (v2)

Supersedes the previous handoff. Paste everything below the line into a new
Claude session to pick this up with full context.

---

I'm building **Odysseus**, my personal crypto trading app: vanilla JS/HTML/CSS,
no build step, at `C:\Users\ZeusG\Downloads\VL` on my Windows machine.

## The design (settled — do not relitigate)

The app does the maths. An **external agent, via MCP**, does the reasoning, as
two deliberately blind analysts:

- a **stochastic analyst** — sees only the indicator/verdict data
- a **news/sentiment analyst** — sees only the structural/headline data, plus
  its own web search

Blindness is **structural** — separate contexts and separate tool grants, not
"ignore the other half" in one prompt. A third step reconciles them; **the clash
is the signal**, not something to average away.

Also settled:

- Elliott Wave stays my own manual read. Do not rebuild it in-app.
- No in-app AI agent layer. Fully and deliberately gone.
- The two MCP tools stay separate — one stoch, one news — on purpose.
- Everything the MCP exposes is read-only.

## What is now BUILT and TESTED (`mcp/`)

All of it is on disk and verified. **Zero dependencies** — plain Node 18+, no
npm install anywhere.

```
mcp/
  server.js        three tools: get_stoch_snapshot, get_news_snapshot, get_watchlist
  protocol.js      dependency-free MCP core: JSON-RPC 2.0, stdio + HTTP transports
  engine.js        the app's own js/*.js driven from Node via tests/harness.js
  client.js        minimal MCP client (tests, and the unattended run)
  check.js         end-to-end proof: `node mcp/check.js` or `--live`
  watchlist.json
  test/fakebybit.js   deterministic fake exchange, COMMITTED so it cannot be lost again
tests/mcp.test.js     85 assertions, in the app's own runner
tests/harness.js      extended (additively) with loadInto/browserStub/topLevelNames
```

**Verified:** `node tests/run.js` → 851 passed, 6 failed. The 6 failures are
pre-existing, in the orphaned agent/Elliott test files, and predate this work —
confirmed by running the suite with the pristine harness first.

`node mcp/check.js` passes end-to-end offline: engine, both transports, all
three tools, argument validation, bearer auth.

**Not reimplemented:** engine.js loads the app's own `js/*.js` into a Node VM
context — the same trick `tests/harness.js` uses — with a real `fetch` and a
no-op DOM. `tests/mcp.test.js` contains a check that recomputes the stochastic
straight from `js/indicators.js` and demands the same %K/%D the engine reported;
that check is what fails if anyone ever writes a second copy of the maths.

Two loops ARE re-driven rather than called (`newsScan()`, `ensureBtc()`) because
they are welded to the DOM and `newsScan()` filters to the top-20 movers, which
is wrong for a tool that must answer about any coin. Every value inside them
still comes from the app's own functions. This is documented in `mcp/README.md`.

## The conversational path is BUILT

```
.mcp.json                          two scoped server processes
.claude/agents/stoch-analyst.md    granted only mcp__odysseus-stoch
.claude/agents/news-analyst.md     granted only mcp__odysseus-news + web search
.claude/commands/read.md           /read SOL — both blind, reconciled, written out
claude/claude-code-setup/          committed copies of the four above, because the
                                   device bridge refuses to write .claude/ or .mcp.json
claude/analyst-runbook.md          how to run it, Claude Code and Claude Desktop
```

`server.js --tools stoch|news` exposes a subset. This is load-bearing: a Claude
Code subagent can only be restricted to a **whole MCP server**, never to
individual tools, so the only way blindness holds is for each analyst's data to
be absent from the process it talks to. Two processes, not one. Confirmed against
the Claude Code docs.

## The app shows the output

A new **Analyst** view (Trading → Analyst): `js/analyst.js`, `css/analyst.css`,
nav + view in `index.html`, `vl.analyst.v1` added to `CLOUD_KEYS`.

It is **not** the agent layer returning. The app holds no key, calls no model,
has no tools. It validates and renders a report something else wrote — and if a
report's summary contradicts its own two analysts (says "agree" over a bull and
a bear), the view flags it and says to trust the two calls. `tests/analyst.test.js`,
56 assertions, guards exactly that.

Reports arrive by drop/paste, or through the existing cloud sync via
`mcp/publish.js`. That publisher is deliberately **not** an MCP tool — the server
stays read-only, so nothing a model can call from a chat alters app state. It
reuses the app's own `analystNormalise`/`analystMerge` through the harness.

## The unattended run is BUILT

`mcp/watch.js` + `mcp/watch.cmd`, on Windows Task Scheduler, hourly. **No API
key** — it drives Claude Code headlessly (`claude -p "/read SYM"
--output-format json --permission-mode dontAsk --allowedTools …`), so it runs on
the existing subscription. Print mode loads the project's `.mcp.json` without a
trust prompt, which is what makes it work from a scheduled task.

The gate is the design, not an optimisation. Fifteen coins hourly is ~720
subagent runs a day almost all concluding nothing changed. So each pass does the
free part first — the engine recomputes the board and every coin's read from the
app's own code and public data, no model call — and a coin reaches the analysts
only on a graded fresh cross (4H+, `playable`/`strong`, 20+ signals), a
coin-specific move ≥8%, an hour at ≥4x volume, or a squeeze/flush with crowded
funding or a ≥10% OI swing. Thresholds are all in `WATCH_CFG`.

Every trigger key names the **event** (the bar the cross printed on, the hour the
move landed in), not the moment of looking, so a cross that stays fresh for hours
is read once. State in `verdicts/.watch-state.json`, pruned after 7 days. A
failed read is NOT remembered, so it retries rather than being swallowed.
`tests/watch.test.js` (38 assertions) pins all of this, including key stability.

Verified end to end against the fake exchange with a stub `claude` binary: pass 1
read 2 of 3 coins, pass 2 was silent.

Reports reach the app via `publish.js`, credentials from
`%USERPROFILE%\.odysseus-cloud.json` (outside the repo) or env vars.

## What is NOT yet done

1. **Verify against the real Bybit API.** Everything was tested against the
   committed fake because the cloud sandbox's network policy blocks
   `api.bybit.com` (403 on CONNECT) — and `device_bash` on my machine has failed
   to start in every session, so nothing could be run there either.
   **Run `node mcp/check.js --live` on my machine.** That is the single
   outstanding verification.
2. **Decide where it runs 24/7.** Cheap VPS / free-tier serverless / the laptop.
   Nothing in the code assumes any of them. HTTP transport is the one that
   matters — a scheduled run fires a fresh session and cannot launch a
   subprocess, so the server must already be running and reachable, and must not
   depend on a browser tab being open.
3. **Push alerts.** The watcher currently delivers into the app only, by
   choice. A desktop toast or phone push on a sharp clash is unbuilt.
4. **Possible third leg: Grok for X/social sentiment.** It has real-time X access
   that neither Claude's web search nor the RSS scraper can match, and
   "why did this alt just pump" is often answered on X before any article. Kept
   blind the same way. The two-analyst baseline comes first.

## Environment facts that keep biting

- `device_bash` on `laptop-6d3r67gr` **does not start** — "Workspace unavailable.
  The isolated Linux environment on this device failed to start." Every session
  so far. So: no shell, no `git`, no `node` on my machine from Claude's side.
  `device_stage_files` / `device_commit_files` work fine and are the reliable path.
- The cloud sandbox blocks `api.bybit.com` **and** `registry.npmjs.org` (403 on
  both). That is why the MCP server has zero dependencies — it was the only way
  to make it testable at all.
- **Nothing has ever been git-committed** across several sessions.

## Orphaned files (17)

Left on disk by the earlier agent-layer and Elliott Wave reverts. Not referenced
by `index.html`; the 6 test failures all come from them.

```
js/agentic.js  js/logan.js  js/maria.js  js/paul.js  js/pretcher.js
js/elliott.js  js/ui-elliott.js  js/watchman.js
css/agentic.css  css/logan.css  css/elliott.css
tests/agentic.test.js  tests/logan.test.js  tests/maria.test.js
tests/paul.test.js  tests/pretcher.test.js  tests/elliott.test.js
```
