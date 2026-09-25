---
description: Run the three blind analysts on a coin and reconcile them into one report
argument-hint: [TICKER] (e.g. /read SOL)
---

Run the full three-analyst read on **$ARGUMENTS**.

## Step 0 — your own record, and only your own

Each analyst's own track record arrives **inside its own tool** —
`get_stoch_snapshot` carries the stoch record, `get_news_snapshot` the news
record, `get_crowd_snapshot` the crowd record, as `yourTrackRecord`, built by
`mcp/score.js` with the same floors every time. There is nothing for you to
read or summarise for them.

Your own record is different. If `verdicts/.desk-brief.md` exists, read it
now: it is how your past reconciliations did — split by the kind of
agreement you were reconciling, and in clashes by which side you followed.
Keep it for Step 2. It is yours alone: do not quote it, paraphrase it, or
hint at it in any analyst's brief.

Do **not** open `verdicts/.track-record-stoch.json`,
`verdicts/.track-record-news.json` or `verdicts/.track-record-crowd.json`,
and do not mention any analyst's past performance in any brief. Reading them
would put every record in this conversation, and anything you then say to
one analyst risks carrying a hint of how the *other* sides have been doing —
exactly the leak the separate processes exist to prevent.

## Step 1 — all three analysts, in parallel, blind

Launch **all three** subagents **in a single message** so they run
concurrently and none can see another's output:

- the `stoch-analyst` subagent, asked for its read on `$ARGUMENTS`
- the `news-analyst` subagent, asked for its read on `$ARGUMENTS`
- the `crowd-analyst` subagent, asked for its read on `$ARGUMENTS`

Do not summarise, paraphrase or hint at any one's findings — or any one's
track record — to the others. Do not call the MCP tools yourself before they
run — if their data lands in this conversation first, you will leak it into
how you brief them, and the blindness is gone. They each have their own
tools; let them use them.

## Step 2 — reconcile

Read all three reports. Your job is **not** to average them, and it is not
to count votes: three analysts is not a majority system. Each one sees a
different thing — the indicator's record, the story and the structure, the
crowd and what it is paying — and the read is what those three things add up
to.

State plainly:

- **Where they agree.** Independent reads reaching the same call from
  different evidence is the strongest signal this system produces. Say so, and
  say what each one's reason was — agreement for the *same* reason is weaker
  than agreement for *different* reasons. All three directional and aligned is
  `agree`; two aligned and one neutral, or one directional and two neutral, is
  `partial`; any two directional calls pointing opposite ways is `clash`.
- **Where they clash.** This is the useful output, not a problem to resolve. A
  clash usually means something specific and nameable:
  - *stoch bull / news bear* — the indicator likes a setup that is running on a
    squeeze or an unexplained thin-book move. The backtest has no idea the bid is
    forced. Usually a fade.
  - *stoch bear / news bull* — a real catalyst is fighting a stretched indicator.
    The historical record does not know about the catalyst. Size small, or wait
    for the indicator to reset.
  - *crowd against the other two* — the crowd analyst is usually saying the move
    is popular and expensive to hold. Read its `stance`: a *fade* against two
    bulls says the trade is right but the entry is crowded and the timing is
    wrong; a *ride* against two bears says the shorts are the ones who will be
    squeezed. Its horizon is short — hours to days — so it can be right about
    the next 24h and the others right about the week, and that is not a
    contradiction; say which horizon you are calling.
  - *crowd with one, against the other* — the crowd usually settles which of the
    two is describing the actual flow. Say which and why.
  - *one confident, the rest neutral* — usually fine; the confident side leads,
    but note that only a third of the evidence supports it.
  - *all neutral* — there is no trade. Say that.
- **What the disagreement is actually about**, in one sentence a tired person can
  read at a glance.

Then weigh your own record from Step 0. If in clashes you have done
markedly better following one side, that is a thumb on the scale — a thumb,
not a rule: read why each side said what it said *this* time before you
lean. If your high-confidence reconciliations have not been more right than
your others, put a lower number on this one. If you have been calling
`split` often, ask whether this one is genuinely split or just unresolved —
split is never graded, and a record made of splits says nothing. Whatever the
record changed, say so in `recordNote`; if nothing, `null`.

Weigh conviction, sample size and evidence quality. A `strong` grade on 40
signals outweighs a `neutral` from an analyst who simply found no headlines. A
cited catalyst published before the sharpest hour outweighs an `untested` frame.
A crowd that is extreme on two series with a week of episodes behind it
outweighs a single funding print.

Do not invent a confident answer out of three uncertain ones.

## Step 3 — write the report

Write the reconciled report to `verdicts/$ARGUMENTS-<YYYY-MM-DD-HHmm>.json` and
copy it to `verdicts/latest.json`, in exactly this shape — it is what the app's
**Analyst** view renders, so the schema matters:

```json
{
  "schema": "odysseus.analyst.v1",
  "symbol": "$ARGUMENTS",
  "generatedAt": "<ISO 8601 UTC>",
  "stoch": { "<the stochastic analyst's JSON block, verbatim>": null },
  "news":  { "<the news analyst's JSON block, verbatim>": null },
  "crowd": { "<the crowd analyst's JSON block, verbatim>": null },
  "reconciliation": {
    "agreement": "agree | partial | clash",
    "direction": "bull | bear | neutral | split",
    "confidence": 0,
    "headline": "<one sentence, the whole read>",
    "body": ["<a short paragraph>", "<another>"],
    "clashes": ["<each specific disagreement, and what it means>"],
    "whatWouldChangeIt": "<the one thing that would flip this>",
    "recordNote": "<what your own record changed about this reconciliation, with the figure — or null>"
  }
}
```

Keep all three analysts' blocks **verbatim**. The point of the record is that
someone reading it later can see each analyst's own reasoning, not just your
synthesis. If an analyst failed to answer, leave its block out rather than
inventing one — the app and the track record treat a missing block as "no
call", never as neutral.

## Step 4 — tell me

In the chat, give me the headline, the agreement state, and the clashes. Three or
four lines. I have the file if I want the detail.

Then, if I am signed into the Cloud panel and want it to appear in the app,
remind me to run:

```
node mcp/publish.js verdicts/latest.json
```
