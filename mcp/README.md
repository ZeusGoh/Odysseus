# Odysseus MCP

A read-only [MCP](https://modelcontextprotocol.io) server that exposes Odysseus's
own reads of the Bybit market to an external agent.

It replaces the in-app agent layer that was deliberately removed. The app does
the maths; an agent outside it does the reasoning.

---

## What it is for

Three analysts, kept **structurally blind** to each other:

| analyst | gets | forms |
|---|---|---|
| stochastic | `get_stoch_snapshot` only | a bull/bear/neutral call from the indicator and the historical record |
| news / sentiment | `get_news_snapshot` only, plus its own web search | an independent call from structure and headlines |
| crowd / positioning | `get_crowd_snapshot` only | an independent call from funding, open interest and the share of accounts long |

A fourth step — the desk — reconciles them. **The clash is the signal** — it is
not something to average away, and three analysts is not a vote.

Blindness has to be structural: three sub-agent calls in a live session, or
three separate API calls in an unattended pipeline. Not one prompt told to
ignore part of its own context — information sitting in a context leaks into
the answer whatever the instruction says.

This is why there are three snapshot tools and not one, and why each tool's
description explicitly disclaims the others' domains. **Do not merge them.**

It is also why the server can expose a **subset** of its tools. An MCP client
grants a chat every tool a server offers — there is no per-conversation tool
picking, and a Claude Code subagent can only be restricted to a whole server. So
the real separation is three processes:

```sh
node mcp/server.js --tools stoch    # get_stoch_snapshot + get_watchlist
node mcp/server.js --tools news     # get_news_snapshot  + get_watchlist
node mcp/server.js --tools crowd    # get_crowd_snapshot + get_watchlist
```

Point each analyst at one of them. Neither can reach the other's data because
the data is not in its process. `.mcp.json` in the repo root wires exactly this
up for Claude Code; `claude/analyst-runbook.md` is the how-to.

---

## Quick start

No install step. No dependencies. Node 18 or newer.

```sh
# prove it works offline, against the committed fake exchange
node mcp/check.js

# prove it works against the real Bybit API
node mcp/check.js --live

# run it
node mcp/server.js              # stdio  — for a desktop MCP client
node mcp/server.js --http       # HTTP   — for scheduled / unattended runs
```

`node mcp/server.js --help` prints the options.

---

## The four tools

### `get_stoch_snapshot`

```json
{ "symbol": "SOL", "force": false }
```

Per timeframe (1H/4H/1D/1W/1M):

- the current cross — type, direction, whether it is still on the live bar, how
  many bars ago, its level and zone, %K and %D, the gap
- any divergence run (direction, legs, settled or forming, how long ago)
- the 200 EMA regime, or an honest refusal when there are fewer than 200 bars
- bar timing: when it opened, when it closes, how long that is
- **the verdict-engine grade** for the cross, measured against every past
  instance of that same setup (frame + direction + zone) on that same coin:
  grade, score, hit rate, median move, sample size, whether the sample is thin,
  how far it beats an ordinary cross on that frame, and a per-horizon breakdown

Plus a timeframe-weighted bias score, BTC alignment frame by frame, and the best
live setup across all frames.

Grades are hard to earn on purpose. The historical record holds a **veto**: no
amount of BTC agreement or trend alignment promotes a setup whose own history
says it does not work. A `negative` or `no edge` grade is a real answer.

### `get_news_snapshot`

```json
{ "symbol": "SOL", "window": "24h", "headlines": true, "force": false }
```

- the move over 1h / 4h / 24h against the **median move of the liquid board**,
  classified three ways: `mkt` market-wide, `part` amplified market move,
  `spec` coin-specific
- the single **sharpest hour** and the volume multiple it printed — "it moved
  sometime today" matches every headline; "it moved between 14:00 and 15:00"
  matches one
- **open interest** change and what it implies: new longs / short squeeze /
  new shorts / long flush; funding rate and whether it is crowded
- a plain-English structural sentence
- **headlines that name the coin**, each labelled `before the move` or
  `after the move` — a headline after the move is reporting, not cause

Coins off the liquid board come back **flagged**, not failed:
`offBoard`, `thinBook`, `measuredOutsideSweep`, each with a caveat sentence.

### `get_watchlist`

```json
{ "names": true }
```

Tickers plus resolved coin names. Use the **names** when searching the web:
`GAS`, `ID`, `OP` and `NEAR` are ordinary English words, and the app's own
matcher once tied a `FLOCK` move to an article about Flock Safety's cameras.

---

## Environment

| variable | default | meaning |
|---|---|---|
| `ODYSSEUS_WATCHLIST` | — | comma-separated tickers; overrides `watchlist.json` |
| `ODYSSEUS_MARKET` | `linear` | `linear` (USDT perpetuals) or `spot` |
| `ODYSSEUS_MIN_LIQ` | `10` | 24h turnover floor in $m for the board sweep |
| `ODYSSEUS_BOARD_WIDTH` | `90` | how many of the deepest books to measure |
| `ODYSSEUS_CACHE_MS` | `90000` | how long a snapshot stays warm |
| `ODYSSEUS_PORT` | `8787` | HTTP port |
| `ODYSSEUS_HOST` | `127.0.0.1` | bind address; `0.0.0.0` to expose |
| `ODYSSEUS_TOKEN` | — | if set, HTTP requires `Authorization: Bearer <token>` |
| `ODYSSEUS_HTTP` | — | `1` is the same as `--http` |
| `ODYSSEUS_HOST_MAP` | — | JSON host→origin rewrites. **Tests only.** |

---

## The two transports

**stdio** (`node server.js`) — newline-delimited JSON on stdin/stdout, for a
desktop MCP client that launches the server as a subprocess. Nothing but
protocol may be written to stdout; all logging goes to stderr.

**HTTP** (`node server.js --http`) — stateless, request-scoped: one POST, one
JSON-RPC response. `GET /health` for a liveness probe.

**HTTP is the one that matters for the unattended case.** A scheduled run fires
a fresh session on a cadence and cannot launch a subprocess, so the server has to
already be running somewhere reachable. That also means it cannot depend on a
browser tab being open — it computes everything from live exchange data itself.

If you expose it beyond localhost, set `ODYSSEUS_TOKEN` and put it behind TLS.
The tools are read-only, but the exchange rate-limits by IP and an open endpoint
is someone else's free market-data feed.

---

## Design notes

**It does not reimplement the app's maths.** `engine.js` loads the app's own
`js/*.js` into a Node VM context through `tests/harness.js` — the same trick the
unit tests use — with a real `fetch` and a no-op DOM swapped in. The stochastic
calculation, cross detection, divergence walk, verdict grading, board-sweep
decomposition and headline matcher are the literal same code the browser runs.
A second copy would drift within a week and start quietly disagreeing with the
app.

`tests/mcp.test.js` has a check that recomputes the stochastic straight out of
`js/indicators.js` and demands the same %K and %D the engine reported. If anyone
ever reimplements the maths inside `mcp/`, that check is what fails.

**Two loops are re-driven rather than called:** `newsScan()` and `ensureBtc()` are
welded to the DOM, and `newsScan()` additionally filters the board down to the
top twenty movers — which is exactly wrong for a tool that must answer about any
coin, moving or not. Every value computed inside those loops still comes from the
app's own functions.

**No dependencies, on purpose.** `protocol.js` is a small MCP server core:
JSON-RPC 2.0 plus `initialize`, `notifications/initialized`, `tools/list`,
`tools/call` and `ping`. The alternative was `@modelcontextprotocol/sdk`, and
every dependency is one more thing that has to install correctly on a machine
that may be hard to reach. `node server.js` works on a box with no npm at all.

**Everything is read-only.** No tool places, cancels or alters an order, and
nothing in `mcp/` writes to disk.

---

## Files

```
mcp/
  server.js        the four tool definitions + entry point + --tools filtering
  protocol.js      dependency-free MCP core (stdio + HTTP transports)
  engine.js        the app's maths, driven from Node
  client.js        a minimal MCP client — for tests, and for driving the
                   unattended two-analyst run
  check.js         end-to-end proof, offline or --live
  publish.js       pushes a finished report into the app's Analyst view
  watch.js         the unattended pass: decides what changed, then reads only that
  watch.cmd        Windows Task Scheduler wrapper for watch.js
  score.js         settles past reports against real price, per analyst, later
  history.js       every call laid against what price did after — the person's view,
                   and the desk's own brief
  postmortem.js    the news analyst explaining its own settled misses (opt-in)
  bybit.js         signing + row-shaping for the Bybit trade import (pure, tested)
  bybit-import.js  pulls your closed Bybit positions into a file the Journal can import
  panel.js         the local relay behind the buttons in the app's Analyst view
  watchlist.json   the default watchlist
  test/
    fakebybit.js   a deterministic fake exchange, committed on purpose
```

Test coverage lives with the rest of the app, in `tests/mcp.test.js`
(`node tests/run.js mcp`).

## Getting a report back into the app

`publish.js` is the one thing in this tree that writes anywhere, and it is
deliberately **not** an MCP tool — the server stays read-only, so nothing a model
can call from a chat alters the app's state. Publishing is a command a person
runs on purpose.

```sh
node mcp/publish.js verdicts/latest.json              # into the app's cloud key
node mcp/publish.js verdicts/latest.json --dry-run    # validate only
node mcp/publish.js verdicts/latest.json --print      # print it, paste by hand
```

It validates with the app's own `analystNormalise` and merges with the app's own
`analystMerge`, both loaded out of `js/analyst.js` — same reasoning as the
engine, no second copy.

---

## Getting your Bybit trades into the journal

`bybit-import.js` pulls your own closed positions out of Bybit and writes them
to a file the Journal's **Import Bybit trades** button reads back in. It never
touches your account password — Bybit authenticates API access with a
key/secret pair you generate yourself, and can scope to read-only, in
**API Management** on Bybit's site. Neither the key nor the secret is ever
stored by the app or sent anywhere but Bybit; they live only in the
environment of the machine you run the script on.

```sh
export ODYSSEUS_BYBIT_KEY=...
export ODYSSEUS_BYBIT_SECRET=...
node mcp/bybit-import.js --dry-run       # check it against your own trade history first
node mcp/bybit-import.js                 # last 90 days, USDT perpetual -> mcp/bybit-trades.json
node mcp/bybit-import.js --days 365
```

Then in the app: **Journal → Import Bybit trades**, pick the file it wrote.
Every imported trade carries the Bybit order id that produced it, so running
the script again — even with an overlapping window — never adds a trade
twice.

Only closed derivatives positions are pulled (`/v5/position/closed-pnl`,
`linear` by default — the same book the app itself reads for candles). Bybit
doesn't record a stop/invalidation price against a settled position, so
imported trades leave that blank; everything downstream (R-multiples, the
sizing panel) already treats a missing stop as "nothing to compute" rather
than zero. There is no spot support yet — spot has no equivalent "one row
per round trip" endpoint, so building it means matching buys against sells by
hand, which is a bigger piece of work than this first pass.

This is a script you run when you want fresh trades, same as `publish.js` —
nothing pulls from Bybit automatically or on a schedule.

---

## Unattended

`watch.js` runs a pass on a schedule without an API key — it drives Claude Code
headlessly, so it uses the existing subscription. The schedule is a Windows
task registered by `claude/register-watch.ps1` (launch/6, or the app's
**Start auto** button): every 30 minutes, hidden, while the PC is awake. A
pass missed while the machine slept runs as soon as it wakes; a scheduled
pass never starts on top of one already running, and `watch.js` holds a lock
file (`verdicts/.watch-lock.json`) so a pass from the app or a launcher cannot
overlap a scheduled one either — the second simply logs that it skipped.

```sh
node mcp/watch.js --dry-run     # decide what is worth reading, spend nothing
node mcp/watch.js               # one real pass
```

The gate is the design: the engine recomputes the board and every coin's read for
free, and a coin reaches the analysts only on a **graded** fresh cross (4H or
slower, `playable`/`strong`, 20+ signals), a **coin-specific** move of 8%+, an
hour at 4x volume, or a squeeze/flush with crowded funding. Thresholds live in
`WATCH_CFG` at the top of the file.

Each trigger's key names the event — the bar the cross printed on — not the
moment of looking, so a cross that stays fresh for hours is read once.

A real read costs roughly $0.50 of subscription usage (two analysts, one of
them searching the web, then a reconciliation) and takes two to four minutes.
Thirty-minute passes with a budget of five is therefore up to ten reads an
hour on a busy board; the event keys keep it far below that most of the time,
but `--max-reads` and `WATCH_CFG.maxReads` are the dial if usage runs hot.

### Scope and budget

Scanning is free, so the pass can look at every liquid book on the exchange
rather than a hand-picked list. `mcp/watchlist.json` sets the scope:

```json
{ "scope": "board", "symbols": ["BTC", "ETH", "SOL"] }
```

- `board` — the same top-N by turnover the News view sweeps (`ODYSSEUS_BOARD_WIDTH`,
  default 90, over the `ODYSSEUS_MIN_LIQ` floor), **plus** whatever is listed,
  so a favourite that slips off the board is still read
- `watchlist` — only the listed symbols
- `app` — the app's built-in symbol list

`--scope` on the command line overrides the file; `ODYSSEUS_WATCHLIST=board`
overrides both.

Reading is not free, so a wide scope needs a **budget** (`WATCH_CFG.maxReads`,
default 5, `--max-reads N`, `0` for none). Every flagged coin is ranked by how
much happened to it — the sum of its trigger weights, so a graded weekly cross
plus a coin-specific move outranks a lone volume print — the top of the ranking
is read, and the rest are named in the log and in `verdicts/.last-pass.json`.
Nothing skipped is remembered, so it goes first next pass if it is still fresh.
The app's Analyst view shows the whole flagged list, greying the ones over
budget, and ranks the fresh reads it has into a **Worth a look** list: the
newest read per coin with a direction, scored by confidence × how the two
analysts agreed (agree 1.0, partial 0.75, clash 0.5 — a clash is the most
interesting output but not a trade). A neutral consensus and a split are left
out; a stale read is left out however confident.

---

## Each analyst's own track record

`score.js` settles old reports against what price actually did — checked at
24h, 48h, 72h and 168h, direction-adjusted, so a bull call that paid off grades
`right` and one that did not grades `wrong`. A move under `DEADBAND_PCT`
(0.5%) either way is `flat`. Each settled checkpoint keeps the price at the
call, the price at the mark, the move between them, and how far price ran each
way on the road there (`maxUp` / `maxDown`), so a call that was right for a
day and wrong by the third can be told from one that never worked. It runs for
free at the start of every `watch.js` pass; nothing needs scheduling
separately, and a checkpoint fills within one pass of coming due.

Two files come out of it, kept deliberately separate:

```
verdicts/.track-record-stoch.json
verdicts/.track-record-news.json
```

**Never merged, and each read by exactly one tool.** `get_stoch_snapshot`
carries the stoch record and `get_news_snapshot` the news record, as
`yourTrackRecord` — built by `scoreBrief()` in `score.js`, in code, on every
snapshot. Nothing in the orchestrating session reads or summarises either
file (`/read` Step 0 says so, and why): the analyst gets its history the same
way it gets its data, from the one process that is allowed to hold it. The
brief is shaped so a model can actually check itself against it, not just nod
at a percentage: its record at every mark; split by the direction it called,
by how sure it said it was (`byConviction` — is a 70 worth more than a 40?)
and by the kind of setup (`bySetup`: "4H bull", "spec, no catalyst"); its own
history on the coin in hand with its last call and how that is going; and its
recent misses with the shape of each — never worked, or worked and reversed —
and what it said at the time. The agent prompts tell each analyst what to do
with those three things: recalibrate its number, weigh the setup in front of
it, and not quietly contradict its own last call.

Rates are withheld under five decided calls; the facts (the last call on this
coin, the misses) are shown whenever they exist. For that, each record also
carries what the call was about — `setup`, `horizon`, `claim` — read off the
analyst's own JSON block when the report is first seen (older records pick
theirs up on the next pass).

**The clock it runs on.** The analyst writes `generatedAt` itself, and it
guesses: two thirds of the reports on one machine were stamped 1–14 hours
off the moment the file was actually written, mostly ahead — and every
checkpoint is timed from that stamp, so a call stamped 13h in the future
took its entry price from the wrong bar and settled 13h late. On every
pass, `scoreStampTime` re-times a report to its file's write time when the
two disagree by more than ten minutes (once; the report keeps the model's
stamp as `generatedAtModel` and is marked), and a record whose report moved
has its checkpoints cleared so they settle again from the right time. A
gap of a day or more is a copied or checked-out file, not a bad stamp, and
is left alone.

Four more things the record does, each there so the record teaches the
right lesson rather than just a lesson:

- **Each call is graded at the mark its own horizon named.** Every call is
  still settled at all four marks — that is the person's view — but the
  analyst's own brief reads each call at the checkpoint its horizon was
  about (`scoreHorizonMark`: "next 20 hours" → 24h, "next 5-7 days" → 168h;
  with no span, the frame decides). Otherwise a weekly call that was early
  reads as wrong at 24h, and the analyst learns to stop making weekly calls.
  `byHorizon` splits the record by that mark.
- **Every settled checkpoint also carries BTC's move over the same window**
  (`btcPct`, `vsBtc`, `gradeVsBtc`) — one BTC fetch per pass. `vsMarket` is
  the record net of BTC, and `marketOnly` counts the right calls that did not
  beat it. A bull call that was right because the whole market rallied is
  right on the move and wrong net of BTC; the second grade is the one that
  says whether the call knew anything.
- **`hedging` counts neutral calls.** Neutral is never graded, so a record
  kept clean by calling neutral is no record at all. Past `SCORE_HEDGE_PCT`
  of the last calls, the brief says so.
- **`bestCalls` / `worstCalls`.** The record's two ends across every coin
  and all time, ranked by the outcome net of BTC at each call's own mark
  (`scoreExtremes`). Always the same number of each, and no call in both —
  a best-only list is the one thing a record can carry that makes the next
  call worse, since it invites matching the setup in hand to a remembered
  win. There so "what was your best call" has an honest answer; the brief's
  text names one of each, together or not at all.
- **`recordNote`.** Each analyst's output block (and the desk's
  reconciliation) now carries one line saying what its own record changed
  about this call, or `null`. It is kept on the record, shown back to the
  analyst next time on the same coin, and rendered on the card in the app —
  so the person can see the record being used rather than trust that it is.

```sh
node mcp/score.js            # settle whatever is due, write the desk's brief, print both digests
node mcp/score.js --quiet    # settle only
```

### The desk's own record

The reconciler is the third call-maker: it picks a side in a clash and puts a
confidence on an agreement. `history.js` grades that from the same price
path, and `historyDeskBrief()` shapes it for the desk itself — split by the
kind of agreement it was reconciling and, in clashes, by which side it
followed (the one decision only the desk makes), plus its confidence bands,
its misses with the headline it wrote, and the same hedging count for `split`.
`score.js` writes it to `verdicts/.desk-brief.md` after every settle; `/read`
Step 0 opens that one file and nothing else. It is the desk's record only —
it never grades either analyst on its own, and the desk is told never to
quote it into either brief.

### Post-mortems (off by default)

A grade says a call was wrong; it does not say what the call missed. For the
news side that is answerable after the fact: `postmortem.js` takes each
settled miss (wrong at the call's own mark, not yet explained, under two
weeks old) and asks the news analyst — with its own tools and nothing else —
to find what actually moved price in that window and what in its reasoning
missed it. Two or three sentences go onto the record as `postmortem`, and the
next brief shows them under the miss. Only the news side: the stochastic
analyst's tool is a live snapshot and cannot look back.

It is a model call per miss, so it is off unless asked for:

```sh
node mcp/watch.js --postmortem       # up to 2 per pass; --postmortem=N for another budget
node mcp/postmortem.js               # by hand
node mcp/postmortem.js --dry-run     # list what would be asked
```

### The history, for the person

`history.js` is the one place both records sit side by side — and it is for
the person only; nothing in it is ever handed to an analyst. One row per
report: what the stoch analyst, the news analyst and the desk each said, the
price at the call, the price at every mark with the excursion in between, and
each side's verdict at each mark. The desk's direction is graded the same way
from the same price path, even though `score.js` never tracks it. While a call
is still waiting on a mark, a live reading says where it stands now (from the
live bar, so a reading, never a settlement). Neutral and split calls are never
right or wrong.

```sh
node mcp/history.js            # every call, as a table
node mcp/history.js --live     # with where each open call stands now
node mcp/history.js --json
```

The relay serves the same thing at `GET /history` (`?live=1` for the live
marks, cached two minutes; `?limit=N`), and the app's **Analyst history**
view renders it with a tally per side per mark on top — each side's overall
line, then the same line split by what it called (bull / bear), under a
heading that counts its calls and says which way it leans. The split is
computed in the app from the rows (`analystHistoryTally`), so it needs no
relay change and can never disagree with the overall figure. Rows and report
cards are collapsed to one line each; pressing one opens the full marks
table, the story and the two sides' cases.

Four more things read off the same rows, all client-side, all in
`js/analyst.js` — win rate alone answers "how often", not "should I act on
this":

- **Magnitude** (`analystHistoryMagnitude`) — the average move, direction-
  adjusted, on right calls against wrong ones: an `avg move` row under each
  side. A call right by 0.4% and one right by 9% used to count the same;
  this is the difference between an edge and a coin flip with a lucky
  record.
- **Confidence calibration** (`analystHistoryCalibration`) — win rate
  bucketed by the conviction/confidence each call carried, read off the same
  "best known verdict" the collapsed strip already shows (last settled
  mark, or the live read while open). If the bands don't separate, the
  number isn't worth weighting.
- **Speed** (`analystHistorySpeed`) — the earliest checkpoint a call reads
  right or wrong, averaged separately for each outcome. Not when everything
  finally settles — when the call first shows its hand, which is the
  patience/sizing question.
- **Backed trades vs the record** (`jAgreementOf` in `js/journal.js`) — the
  journal's existing Patterns breakdown now includes "Analyst agreement at
  entry," grouping your own logged, closed trades by the agreement type
  (agree/partial/clash) of whatever call backed them, with the same win
  rate / avg R every other pattern row shows. This is the one the others
  can't get to: a call graded "right" doesn't mean the trade made money —
  sizing, entry, exit are yours — so it reads straight off the snapshot
  attached at logging time rather than re-grading the call.

Confidence calibration and speed are shown for the stoch and news analysts
only — the desk's number is a reconciliation, not a forecast with a
confidence dial worth calibrating the same way.

Below those, **by combination** (`analystHistoryCombos`, `analystHistoryComboTally`):
what the three said together — "S bull · N bull · D bull", "S bull · N bear
· D bull" — and how each went, graded on the desk's call because that is the
one there is to trade. A pair on top rolls it up as the question actually
being asked: **all three agree** against **not all three**. A combination
whose desk call is split or neutral is listed (it happened) but has nothing
to grade.

---

## Buttons in the app

`panel.js` is a small local HTTP server the app's **Analyst** view talks to,
so you can run a read, start the hourly watcher, or push a report to Cloud by
clicking in Odysseus instead of double-clicking launchers. It streams the
command's output into the view and, when a read finishes, hands the report to
the app through the same validator a pasted file goes through.

```sh
node mcp/panel.js              # 127.0.0.1:8790 — launch/10 does this, minimised
```

**Always on.** `launch\11 - Relay always on` registers a Task Scheduler task
(`claude/register-relay.ps1`) that runs `mcp/relay-hidden.vbs` at every logon:
no window, and the relay is restarted after five seconds if it ever exits. Do
it once and `launch\10` is never needed again. Unlike the watch task the
keeper script *waits* on the relay, so Task Scheduler sees the task as running
for as long as the relay is, and has no execution time limit (the default
one-hour limit would kill it hourly). Output goes to `verdicts/relay.log`.
`launch\12` removes the task and stops the relay. A second relay on the same
port — `launch\10` pressed while the task runs — exits with code 3 and a
one-line message; the keeper reads that code as "stand down", not "retry".

It is **not** the agent layer coming back, and it is worth being precise about
why. The relay holds no model key and cannot reason; it has a fixed list of
eight actions (dry run, pass, read one symbol, publish, settle, start/stop the
hourly task, ask) and refuses anything else, so there is nothing a page could
ask it to run that the launchers do not already run. The symbol is a regex, not
a string that reaches a shell.

**Ask** is the one action that carries free text, and it is worth saying
exactly where that text goes: onto the stdin of a `claude -p` session as a
prompt. It reaches a model, never a shell. The reply comes back to the app as
text, rendered escaped like a pasted report. Follow-ups ride on `--resume`, so
each conversation remembers itself until you start it over; the transcript
lives in `verdicts/.chat.json` so a relay restart does not lose it. Every
question costs model calls on the subscription, like a read.

You choose who answers, and each is its own session and its own memory:

| ask | what it is | how it is kept honest |
|---|---|---|
| **stoch analyst** | the blind indicator analyst | its session is started with **only** `odysseus-stoch` loaded (`--strict-mcp-config --mcp-config claude/claude-code-setup/mcp-stoch.json`), the news server and the web **denied** (`--disallowedTools`), no `Task` so it cannot dispatch anyone, and `stoch-analyst.md` as its brief |
| **news analyst** | the blind news analyst | the mirror image: only `odysseus-news` loaded, the other servers denied, web allowed |
| **crowd analyst** | the blind positioning analyst | only `odysseus-crowd` loaded, the other servers and the web denied, no `Task`, and `crowd-analyst.md` as its brief |
| **the desk** | the reconciler — the only role that sees all three | the `/read` command's own session: all three servers, `Task` to dispatch the analysts, `Write` so a full read lands in `verdicts/` |

That is the same separation the `/read` command gets from subagent tool
grants, done with session flags instead — and it is enforced by Claude Code,
not by the prompt. Asking the stoch analyst about a headline gets you "I
cannot see that"; that is the design working. It binds to 127.0.0.1 only, accepts requests only
from an origin on this machine (`localhost`, `127.0.0.1`, or a file opened from
disk — a website open in another tab is refused), and runs one job at a time.
Set `ODYSSEUS_PANEL_TOKEN` to require a token on top of that, and
`ODYSSEUS_PANEL_ORIGIN` if you host the app somewhere other than localhost.

`tests/panel.test.js` pins the action list, the symbol rule, the origin check
and one real HTTP round trip.

## Still to do

1. **Pick where this runs 24/7.** `watch.js` only runs while the laptop is awake.
   A cheap VPS or an always-on box would fix that; nothing here assumes either.
2. **A possible third leg:** X/social sentiment via Grok, which has real-time X
   access that neither web search nor an RSS scraper can match — and "why did this
   alt just pump" is often answered on X before it is in any article. Kept blind
   the same way, as a third process with its own tool.
