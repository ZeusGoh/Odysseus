#!/usr/bin/env node
/* score.js — settles past analyst calls against what price actually did.

   Every report /read writes gets checked later, at 24h / 72h / 168h, against
   real price: did the coin move the way the call said it would. Two SEPARATE
   track records come out of this — one for the stochastic analyst, one for
   the news analyst — never merged into one file, because a merged file would
   quietly leak one analyst's calls into what the other reads before its next
   run. The blindness that matters between the two live analysts has to hold
   for their history too, not just their live data.

   The settlement mechanics (fixed checkpoints, pending/expired/ok coverage,
   never rewrite a settled checkpoint) mirror js/anomalies.js's anomPriceAt /
   anomCovers / anomScore exactly — that file already solved "was this flag
   right, checked later, against real price" for market anomalies. Reimplemented
   here rather than loaded through the VM harness: anomalies.js reads
   localStorage at module load time, which the engine's browser stub does not
   provide, and the two functions that matter are six lines each. Grading a
   directional bull/bear/neutral CALL is a different question from grading an
   anomaly flag's held/faded/reversed, so that part is new.

   part of Odysseus */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VERDICTS = path.join(ROOT, 'verdicts');
const HOUR = 3600000;

/* ==SCORE_START== */
/*  How long after a call to check it, in hours: one day, two, three, a week.
    Fixed and uniform across both analysts rather than parsed out of each
    report's free-text horizon ("next 24-48 hours", "1D, next 5-7 days") —
    simpler, and the digest can just show all of them so the analyst judges
    which one is relevant to the call it is about to make.                 */
const SCORE_CHECKS = [24, 48, 72, 168];

// a move smaller than this, in the call's own direction, is noise, not a call
const DEADBAND_PCT = 0.5;

// fewer settled calls than this and a rate is not worth reporting as one
const MIN_FOR_DIGEST = 5;

// how many settled calls back a digest looks at
const DIGEST_WINDOW = 30;

/*  The settled close as of `at` — mirrors anomPriceAt exactly. A bar stamped
    t has not happened, in the sense of being knowable, until t+1h.        */
function scorePriceAt(bars, at) {
  let out = null;
  for (const b of bars || []) {
    if (b.t + HOUR <= at) out = b.c; else break;
  }
  return out;
}

/*  Mirrors anomCovers: can this bar series answer for a moment `at` yet, or
    has it not happened, or did the history window roll past it.          */
function scoreCovers(bars, at) {
  if (!bars || !bars.length) return 'missing';
  if (at > bars[bars.length - 1].t + HOUR) return 'pending';
  if (at < bars[0].t + HOUR) return 'expired';
  return 'ok';
}

/*  right / wrong / flat, direction-adjusted so + always means the call would
    have been correct — the same sign convention anomGrade and replayCrosses
    use. A neutral call makes no directional claim, so there is nothing to
    grade; it is excluded rather than forced into right or wrong.          */
function callGrade(call, pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (call !== 'bull' && call !== 'bear') return null;
  const signed = call === 'bull' ? pct : -pct;
  if (signed > DEADBAND_PCT) return 'right';
  if (signed < -DEADBAND_PCT) return 'wrong';
  return 'flat';
}

/*  How far price ran each way between the call and `to`, as a percentage of
    `entry` — the best and worst the call ever looked in that window, not
    just where it ended. Every bar that CLOSED after the call and by `to`
    counts (with `to` open-ended for a live reading, so the bar in progress
    counts too); highs and lows are the bar's own, falling back to the close
    for a series that carries none. Null when no bar has closed yet.        */
function scoreExcursion(bars, entry, fromMs, toMs) {
  if (!entry || !(bars || []).length) return null;
  let maxUp = null, maxDown = null, n = 0;
  for (const b of bars) {
    const closes = b.t + HOUR;
    if (closes <= fromMs) continue;
    if (toMs != null && closes > toMs) break;
    const hi = Number.isFinite(b.h) ? b.h : b.c, lo = Number.isFinite(b.l) ? b.l : b.c;
    const up = (hi - entry) / entry * 100, down = (lo - entry) / entry * 100;
    if (maxUp == null || up > maxUp) maxUp = up;
    if (maxDown == null || down < maxDown) maxDown = down;
    n++;
  }
  if (!n) return null;
  return { maxUp: +Math.max(maxUp, 0).toFixed(2), maxDown: +Math.min(maxDown, 0).toFixed(2), bars: n };
}

/*  Fills whatever checkpoints are due and not yet settled. Pure aside from
    the bars it is handed — the caller does the fetching, so this can be
    tested without a network. Returns the number of checkpoints filled.
    Never rewrites a checkpoint once it has a result, same discipline as
    anomScore: a settled reading is a fact, not a draft.

    Each settled checkpoint keeps the whole story, not just the verdict:
    the price the call was made at, the price at the checkpoint, the move
    between them, and how far it ran each way on the road there — so a
    "wrong" that was right for 20 hours and a "wrong" that never worked
    can be told apart later.                                             */
/*  `btcBars`, when given, adds the baseline: BTC's move over the very same
    window, the call's move net of it, and a second grade on that net
    move. A bull call that was "right" because the whole market rallied
    is right on `grade` and flat or wrong on `gradeVsBtc` — and it is the
    second one that says whether the call knew anything. BTC's own calls
    get no baseline (it would be zero by construction).                  */
const BASELINE_SYMBOL = 'BTC';

function settleRecord(record, bars, now, btcBars) {
  let filled = 0;
  const generatedAtMs = Date.parse(record.generatedAt);
  if (!Number.isFinite(generatedAtMs)) return filled;

  for (const h of SCORE_CHECKS) {
    const key = String(h);
    if (record.checks[key]) continue;               // already settled
    const at = generatedAtMs + h * HOUR;
    if (at > now) continue;                          // not due yet

    const cover = scoreCovers(bars, at);
    const coverEntry = scoreCovers(bars, generatedAtMs);
    if (cover === 'pending') continue;                // this fetch cannot see that far forward
    if (cover === 'expired' || coverEntry === 'expired') {
      record.checks[key] = { state: 'expired' };
      filled++;
      continue;
    }

    const entry = scorePriceAt(bars, generatedAtMs);
    const exit = scorePriceAt(bars, at);
    if (entry == null || exit == null || !entry) continue;   // try again next pass

    const pct = (exit - entry) / entry * 100;
    const ex = scoreExcursion(bars, entry, generatedAtMs, at);
    const c = Object.assign(
      { pct: +pct.toFixed(2), grade: callGrade(record.call, pct), entry, exit },
      ex ? { maxUp: ex.maxUp, maxDown: ex.maxDown } : {});
    if (btcBars && String(record.symbol).toUpperCase() !== BASELINE_SYMBOL) {
      const bEntry = scorePriceAt(btcBars, generatedAtMs), bExit = scorePriceAt(btcBars, at);
      if (bEntry != null && bExit != null && bEntry) {
        const btcPct = (bExit - bEntry) / bEntry * 100;
        c.btcPct = +btcPct.toFixed(2);
        c.vsBtc = +(pct - btcPct).toFixed(2);
        c.gradeVsBtc = callGrade(record.call, pct - btcPct);
      }
    }
    record.checks[key] = c;
    filled++;
  }
  return filled;
}

/*  Where a call stands right now, before its next checkpoint: the price at
    the call, the last price the bars carry (the live bar, so it is a
    reading, not a settlement), the move so far and the excursion so far.
    Null when the bars cannot price the entry. Never written to the record —
    it changes every hour, and the record holds facts.                    */
function scoreLiveMark(record, bars, now) {
  const generatedAtMs = Date.parse(record.generatedAt);
  if (!Number.isFinite(generatedAtMs) || !(bars || []).length) return null;
  const entry = scorePriceAt(bars, generatedAtMs);
  if (entry == null || !entry) return null;
  const last = bars[bars.length - 1];
  if (!Number.isFinite(last.c)) return null;
  const pct = (last.c - entry) / entry * 100;
  const ex = scoreExcursion(bars, entry, generatedAtMs, null);
  return Object.assign(
    { entry, price: last.c, pct: +pct.toFixed(2), grade: callGrade(record.call, pct),
      hoursIn: +((now - generatedAtMs) / HOUR).toFixed(1), at: now },
    ex ? { maxUp: ex.maxUp, maxDown: ex.maxDown } : {});
}

/*  A call is open while any checkpoint is still unsettled — due or not.
    Once every one has a result (or expired), it is history.             */
function scoreIsOpen(record) {
  return SCORE_CHECKS.some(h => !(record.checks || {})[String(h)]);
}

/*  The next checkpoint a record is waiting on, and when it lands.        */
function scoreNextCheck(record, now) {
  const generatedAtMs = Date.parse(record.generatedAt);
  if (!Number.isFinite(generatedAtMs)) return null;
  for (const h of SCORE_CHECKS) {
    if ((record.checks || {})[String(h)]) continue;
    const dueAt = generatedAtMs + h * HOUR;
    return { hours: h, dueAt, due: dueAt <= now };
  }
  return null;
}

/*  A short, honest digest of one analyst's own track record — and only ever
    called with one analyst's own records. It does not know the other side
    exists.                                                                */
function scoreDigest(records, checkHours) {
  const h = String(checkHours || 24);
  const scored = (records || [])
    .filter(r => r.checks[h] && r.checks[h].grade)
    .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt))
    .slice(0, DIGEST_WINDOW);

  if (scored.length < MIN_FOR_DIGEST)
    return { count: scored.length, text: scored.length
      ? `Only ${scored.length} call(s) settled at ${h}h so far — too few to say anything about the pattern yet.`
      : `No settled track record yet at ${h}h.` };

  const right = scored.filter(r => r.checks[h].grade === 'right').length;
  const wrong = scored.filter(r => r.checks[h].grade === 'wrong').length;
  const flat = scored.filter(r => r.checks[h].grade === 'flat').length;
  const decided = right + wrong;
  const rate = decided ? Math.round((right / decided) * 100) : null;

  const misses = scored.filter(r => r.checks[h].grade === 'wrong').slice(0, 3)
    .map(r => `${r.symbol} ${r.call} on ${r.generatedAt.slice(0, 10)} (${r.checks[h].pct > 0 ? '+' : ''}${r.checks[h].pct}%)`);

  let text = `Last ${scored.length} calls, checked at ${h}h: ${right} right, ${wrong} wrong` +
    (flat ? `, ${flat} flat` : '') + (rate != null ? ` (${rate}% of decided calls)` : '') + '.';
  if (misses.length) text += ' Recent misses: ' + misses.join('; ') + '.';
  return { count: scored.length, rightCount: right, wrongCount: wrong, flatCount: flat, rate, text };
}

/* ---------- what a call was ABOUT, kept on the record ----------
   A grade on its own teaches nothing: "wrong" is only useful next to what
   kind of call it was. So each record also carries a compact tag for the
   setup the analyst leaned on, the horizon it named and its first stated
   reason — side-specific, read off the analyst's own JSON block, never off
   the other side's. That is what lets the brief say "your 4H bull calls"
   or "your spec calls with no catalyst" rather than just "your calls".  */
const SCORE_FRAMES = ['1M', '1W', '1D', '4H', '1H'];

function scoreFrameOf(text) {
  const s = String(text || '').toUpperCase();
  for (const f of SCORE_FRAMES) if (new RegExp('(^|[^A-Z0-9])' + f + '([^A-Z0-9]|$)').test(s)) return f;
  return null;
}

/*  Which checkpoint a call is really about. Every call is still settled at
    all four marks — that is the person's record — but the analyst's OWN
    record grades each call at the mark its horizon named, so a "1D, next
    5-7 days" call is not marked wrong at 24h and taught to stop making
    weekly calls. The span is read off the horizon text (the largest number
    with a unit wins: "next 24-48 hours" is 48h); with no span, the frame
    decides; with neither, 24h. Always one of SCORE_CHECKS.               */
const SCORE_FRAME_SPAN_H = { '1H': 24, '4H': 24, '1D': 72, '1W': 168, '1M': 168 };

function scoreHorizonMark(horizon, setup) {
  const s = String(horizon || '').toLowerCase();
  let span = null;
  const re = /(\d+(?:\.\d+)?)\s*(?:(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(h\b|hr\b|hrs\b|hour|hours|d\b|day|days|w\b|wk\b|week|weeks)/g;
  let m;
  while ((m = re.exec(s))) {
    const n = Number(m[2] != null ? m[2] : m[1]);
    const unit = m[3][0];
    const hours = unit === 'h' ? n : unit === 'd' ? n * 24 : n * 168;
    if (Number.isFinite(hours) && (span == null || hours > span)) span = hours;
  }
  if (span == null) {
    const frame = scoreFrameOf(setup) || scoreFrameOf(horizon);
    span = frame ? SCORE_FRAME_SPAN_H[frame] : SCORE_CHECKS[0];
  }
  for (const h of SCORE_CHECKS) if (span <= h) return h;
  return SCORE_CHECKS[SCORE_CHECKS.length - 1];
}

// the mark a record's own grade is read at — records written before marks existed read at the first one
function scoreRecordMark(r) {
  return r && SCORE_CHECKS.includes(r.mark) ? r.mark : SCORE_CHECKS[0];
}

function scoreDescribe(side, block) {
  const b = block && typeof block === 'object' ? block : {};
  const kn = b.keyNumbers && typeof b.keyNumbers === 'object' ? b.keyNumbers : {};
  const call = b.call || null;
  const horizon = typeof b.horizon === 'string' ? b.horizon.trim() : null;
  const claim = Array.isArray(b.for) && typeof b.for[0] === 'string' ? b.for[0].trim().slice(0, 160) : null;
  // what the analyst itself said its record changed about this call, if anything
  const recordNote = typeof b.recordNote === 'string' && b.recordNote.trim() ? b.recordNote.trim().slice(0, 240) : null;
  let setup;
  if (side === 'stoch') {
    const frame = scoreFrameOf(kn.bestSetup) || scoreFrameOf(horizon);
    setup = (frame || '?') + ' ' + (call || '?');
  } else if (side === 'crowd') {
    // the kind of positioning the call rested on: the crowd read's tag, or which side was crowded
    const tag = typeof kn.crowdTag === 'string' && kn.crowdTag.trim() ? kn.crowdTag.trim().toLowerCase().slice(0, 40) : null;
    const crowded = ['long', 'short'].includes(kn.crowdedSide) ? 'crowded ' + kn.crowdedSide : null;
    setup = (tag || crowded || 'no read') + ' → ' + (call || '?');
  } else {
    const cls = ['mkt', 'part', 'spec'].includes(kn.classification) ? kn.classification : '?';
    const cat = b.catalyst && typeof b.catalyst === 'object' ? !!b.catalyst.found : null;
    setup = cls + (cat === true ? ' + catalyst' : cat === false ? ', no catalyst' : '');
  }
  return { horizon, setup, claim, recordNote, mark: scoreHorizonMark(horizon, side === 'stoch' ? kn.bestSetup : null) };
}

/* ---------- the brief: one analyst's own record, shaped to learn from ----------

   scoreDigest is a sentence for a person. This is what an analyst gets in
   its snapshot before it writes a call, and it is built so the model can
   actually check itself against it rather than nod at a percentage:

     - its record at every mark (24/48/72/168h), so it picks the one its
       horizon is about;
     - split by the direction it called, by how sure it said it was, and
       by the kind of setup — the three ways a bias actually shows up
       ("your bear calls", "your 70+ calls", "your 1H bull calls");
     - its own history on THIS coin, with its last call and how that went;
     - its recent misses with the shape of each one: never worked, or
       worked for a while and reversed — those are different lessons.

   Rates are withheld under MIN_FOR_DIGEST decided calls — a 1-of-2 is not
   a rate — but the facts (this coin's last call, the misses) are shown
   whenever they exist. Pure: hands in records and a context, gets an
   object back. It is only ever handed ONE analyst's records; it does not
   know the other side exists.                                            */
const SCORE_BRIEF_MISSES = 4;
const SCORE_BRIEF_HITS = 2;

/*  `mark` is a checkpoint ('24', 48, …) or 'own' — each record at the mark
    its own horizon named. `field` is which grade to read: `grade` (the
    move itself) or `gradeVsBtc` (the move net of BTC over the same
    window); a checkpoint with no baseline kept counts as pending there. */
function scoreTally(records, mark, field) {
  const f = field || 'grade';
  let right = 0, wrong = 0, flat = 0, pending = 0;
  for (const r of records) {
    const h = mark === 'own' ? String(scoreRecordMark(r)) : String(mark);
    const c = r.checks && r.checks[h];
    if (!c || !c[f]) { pending++; continue; }
    if (c[f] === 'right') right++;
    else if (c[f] === 'wrong') wrong++;
    else if (c[f] === 'flat') flat++;
  }
  const decided = right + wrong;
  const rate = decided >= MIN_FOR_DIGEST ? Math.round(right / decided * 100) : null;
  return { n: right + wrong + flat, right, wrong, flat, pending, rate,
           note: decided && decided < MIN_FOR_DIGEST ? 'fewer than ' + MIN_FOR_DIGEST + ' decided — not a rate yet' : null };
}

function scoreGroup(records, mark, keyFn, order) {
  const groups = {};
  for (const r of records) {
    const k = keyFn(r);
    if (k == null) continue;
    (groups[k] = groups[k] || []).push(r);
  }
  const keys = order ? order.filter(k => groups[k]).concat(Object.keys(groups).filter(k => !order.includes(k)).sort())
                     : Object.keys(groups).sort();
  const out = {};
  for (const k of keys) out[k] = scoreTally(groups[k], mark);
  return out;
}

function scoreConvictionBand(r) {
  const c = Number(r.conviction);
  if (!Number.isFinite(c)) return null;
  return c >= 70 ? 'high (70+)' : c >= 40 ? 'mid (40-69)' : 'low (<40)';
}

/*  The shape of a miss, from the excursion the checkpoint kept: a bull call
    that reached +3% before closing -2% and one that never printed green
    are different mistakes — early, versus wrong.                        */
function scoreMissShape(call, c) {
  if (!c || c.maxUp == null || c.maxDown == null) return null;
  const went = call === 'bull' ? c.maxUp : -c.maxDown;
  if (went > DEADBAND_PCT * 2) return 'worked for a while (' + (call === 'bull' ? '+' + c.maxUp : c.maxDown) + '% at best) then reversed';
  return 'never went your way';
}

function scoreCallLine(r, marks) {
  const parts = [];
  for (const h of marks) {
    const c = r.checks && r.checks[String(h)];
    if (!c || c.state === 'expired') continue;
    parts.push(h + 'h ' + (c.pct > 0 ? '+' : '') + c.pct + '% ' + (c.grade || '?'));
  }
  return parts.join(', ');
}

// how many neutral calls in a row of recent ones before the brief says so
const SCORE_HEDGE_MIN = 5;
const SCORE_HEDGE_PCT = 60;

/*  The record's two ends, across the WHOLE file — every coin, all time, not
    the recent window. Ranked by the outcome net of BTC at the call's own
    mark (raw move where no baseline was kept), sign-adjusted so a bear
    call's fall counts up: "best" is the call that beat the market by the
    most, not the biggest candle it happened to be standing near.

    Both ends, always, and the same number of each. A list of one's best
    calls alone is the one thing a record can carry that makes the next
    call worse — it invites matching the setup in hand to a remembered
    win. The worst are recentMisses' cousins: those are the newest wrong
    calls, these are the costliest ever. Pure; one analyst's records only. */
const SCORE_EXTREMES = 3;
function scoreExtremes(records, limit) {
  const n = limit == null ? SCORE_EXTREMES : limit;
  const rows = [];
  for (const r of records || []) {
    if (!r || !r.symbol || !r.checks || !(r.call === 'bull' || r.call === 'bear')) continue;
    const mark = scoreRecordMark(r);
    const c = r.checks[String(mark)];
    if (!c || (c.grade !== 'right' && c.grade !== 'wrong' && c.grade !== 'flat')) continue;
    const raw = c.vsBtc != null ? c.vsBtc : c.pct;
    if (raw == null || !isFinite(raw)) continue;
    const net = +(r.call === 'bear' ? -raw : raw).toFixed(2);
    rows.push({
      symbol: r.symbol, date: String(r.generatedAt).slice(0, 10), call: r.call,
      conviction: r.conviction == null ? null : r.conviction, setup: r.setup || null, claim: r.claim || null,
      mark, pct: c.pct == null ? null : c.pct, btcPct: c.btcPct == null ? null : c.btcPct,
      vsBtc: c.vsBtc == null ? null : c.vsBtc, net, netOf: c.vsBtc != null ? 'btc' : 'move', grade: c.grade,
      postmortem: r.postmortem && r.postmortem.text ? r.postmortem.text : null,
    });
  }
  rows.sort((a, b) => b.net - a.net || a.symbol.localeCompare(b.symbol));
  // no call sits in both lists: the worst are taken from what is left after the best
  return { best: rows.slice(0, n), worst: rows.slice(n).slice(-n).reverse(), ranked: rows.length };
}

function scoreBrief(records, ctx) {
  const o = ctx || {};
  const now = o.now || Date.now();
  const symbol = o.symbol ? String(o.symbol).toUpperCase() : null;
  const marks = SCORE_CHECKS;
  const all = (records || []).filter(r => r && r.symbol && r.checks)
    .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
  const graded = all.filter(r => r.call === 'bull' || r.call === 'bear');   // neutral calls are not graded
  const recent = graded.slice(0, DIGEST_WINDOW);
  const ownMark = r => String(scoreRecordMark(r));
  const settled = recent.filter(r => r.checks[ownMark(r)] && r.checks[ownMark(r)].grade);
  const settledAt24 = recent.filter(r => r.checks['24'] && r.checks['24'].grade);

  /*  Every mark for the record, plus `own`: each call read at the mark its
      horizon named. The splits below are all at `own` — that is the fair
      question, "was this call right on the span it was made for".        */
  const overall = { own: scoreTally(recent, 'own') };
  for (const h of marks) overall[String(h)] = scoreTally(recent, h);
  const vsMarket = scoreTally(recent, 'own', 'gradeVsBtc');

  const byCall = scoreGroup(recent, 'own', r => r.call, ['bull', 'bear']);
  const byConviction = scoreGroup(recent, 'own', scoreConvictionBand, ['high (70+)', 'mid (40-69)', 'low (<40)']);
  const bySetup = scoreGroup(recent, 'own', r => r.setup || null, null);
  const byMark = scoreGroup(recent, 'own', r => ownMark(r) + 'h', marks.map(h => h + 'h'));

  /*  Neutral is never graded, so a record kept clean by calling neutral is
      not a good record — it is an absent one. Counted over the last
      DIGEST_WINDOW calls of every kind, and said out loud past a share.  */
  const recentAll = all.slice(0, DIGEST_WINDOW);
  const neutralN = recentAll.filter(r => r.call === 'neutral').length;
  const hedging = {
    neutral: neutralN, ofLast: recentAll.length,
    pct: recentAll.length ? Math.round(neutralN / recentAll.length * 100) : null,
    warn: recentAll.length >= SCORE_HEDGE_MIN && neutralN / recentAll.length * 100 >= SCORE_HEDGE_PCT,
  };

  // this coin: every graded call on it, and the latest one in full
  const mine = symbol ? graded.filter(r => r.symbol === symbol) : [];
  const last = symbol ? all.find(r => r.symbol === symbol) || null : null;   // the newest, neutral included
  let lastCall = null;
  if (last) {
    const ageH = (now - Date.parse(last.generatedAt)) / HOUR;
    lastCall = {
      generatedAt: last.generatedAt, hoursAgo: +ageH.toFixed(1),
      call: last.call, conviction: last.conviction == null ? null : last.conviction,
      horizon: last.horizon || null, setup: last.setup || null, claim: last.claim || null,
      recordNote: last.recordNote || null, mark: scoreRecordMark(last),
      open: scoreIsOpen(last),
      settled: scoreCallLine(last, marks) || null,
      live: o.bars && scoreIsOpen(last) ? scoreLiveMark(last, o.bars, now) : null,
    };
  }
  const onThisCoin = symbol ? { symbol, calls: mine.length, own: scoreTally(mine, 'own'), at24: scoreTally(mine, 24), lastCall } : null;

  const missOf = r => {
    const c = r.checks[ownMark(r)];
    return {
      symbol: r.symbol, date: String(r.generatedAt).slice(0, 10), call: r.call, conviction: r.conviction == null ? null : r.conviction,
      setup: r.setup || null, claim: r.claim || null, mark: scoreRecordMark(r),
      result: scoreCallLine(r, marks), shape: scoreMissShape(r.call, c),
      btcPct: c.btcPct == null ? null : c.btcPct, vsBtc: c.vsBtc == null ? null : c.vsBtc,
      postmortem: r.postmortem && r.postmortem.text ? r.postmortem.text : null,
    };
  };
  const misses = settled.filter(r => r.checks[ownMark(r)].grade === 'wrong').slice(0, SCORE_BRIEF_MISSES).map(missOf);
  const hits = settled.filter(r => r.checks[ownMark(r)].grade === 'right').slice(0, SCORE_BRIEF_HITS).map(r => {
    const c = r.checks[ownMark(r)];
    return { symbol: r.symbol, date: String(r.generatedAt).slice(0, 10), call: r.call, conviction: r.conviction == null ? null : r.conviction,
             setup: r.setup || null, mark: scoreRecordMark(r), result: scoreCallLine(r, marks),
             beatBtc: c.gradeVsBtc ? c.gradeVsBtc === 'right' : null };
  });
  // rights that were only the market: right on the move, not right net of BTC
  const marketOnly = settled.filter(r => { const c = r.checks[ownMark(r)]; return c.grade === 'right' && c.gradeVsBtc && c.gradeVsBtc !== 'right'; }).length;
  // the whole record's two ends — every coin, all time (not the recent window)
  const extremes = scoreExtremes(graded);

  /* ---- the words ---- */
  const lines = [];
  const own = overall.own;
  if (!all.length) lines.push('You have no track record yet.');
  else if (!settled.length) lines.push('You have made ' + all.length + ' call(s); none has reached the checkpoint its horizon named yet.');
  else {
    lines.push('Your last ' + recent.length + ' directional call(s), each read at the mark its own horizon named: ' + own.right + ' right, ' + own.wrong + ' wrong' +
      (own.flat ? ', ' + own.flat + ' flat' : '') + (own.pending ? ', ' + own.pending + ' still open' : '') +
      (own.rate != null ? ' — ' + own.rate + '% of decided.' : ' — too few decided to call a rate.'));
    if (vsMarket.rate != null || vsMarket.right + vsMarket.wrong) {
      lines.push('Net of BTC over the same windows: ' + vsMarket.right + ' right, ' + vsMarket.wrong + ' wrong' +
        (vsMarket.flat ? ', ' + vsMarket.flat + ' flat' : '') + (vsMarket.rate != null ? ' (' + vsMarket.rate + '%)' : '') + '.' +
        (marketOnly ? ' ' + marketOnly + ' of your right calls did not beat BTC — the market did that, not the call.' : ''));
    }
    const say = (label, g) => {
      const parts = Object.keys(g).filter(k => g[k].rate != null).map(k => k + ' ' + g[k].rate + '% of ' + (g[k].right + g[k].wrong));
      if (parts.length) lines.push(label + ': ' + parts.join('; ') + '.');
    };
    say('By call', byCall);
    say('By your own conviction', byConviction);
    say('By setup', bySetup);
    say('By horizon', byMark);
    const hi = byConviction['high (70+)'], lo = byConviction['low (<40)'], mid = byConviction['mid (40-69)'];
    const lower = [lo, mid].filter(x => x && x.rate != null);
    if (hi && hi.rate != null && lower.length && lower.every(x => hi.rate <= x.rate))
      lines.push('Your high-conviction calls have not been more right than your others — the number you put on a call is not yet earning its keep.');
  }
  if (hedging.warn)
    lines.push('You have called neutral on ' + hedging.neutral + ' of your last ' + hedging.ofLast + '. Neutral is never graded, so a record kept clean this way says nothing — call neutral when the data is neutral, not to protect the record.');
  if (onThisCoin && onThisCoin.lastCall) {
    const lc = onThisCoin.lastCall;
    let s = 'On ' + symbol + ': you called ' + lc.call + (lc.conviction != null ? ' at ' + lc.conviction : '') +
      ' ' + lc.hoursAgo + 'h ago' + (lc.setup ? ' (' + lc.setup + ')' : '');
    if (lc.settled) s += ' — ' + lc.settled;
    if (lc.live && lc.live.pct != null) s += ' — now ' + (lc.live.pct > 0 ? '+' : '') + lc.live.pct + '%' + (lc.live.grade ? ', ' + lc.live.grade + ' so far' : '');
    lines.push(s + '.');
    if (lc.recordNote) lines.push('Last time you wrote: "' + lc.recordNote + '"');
    if (onThisCoin.calls > 1 && onThisCoin.own.rate != null)
      lines.push('Your record on ' + symbol + ': ' + onThisCoin.own.right + ' right, ' + onThisCoin.own.wrong + ' wrong (' + onThisCoin.own.rate + '%).');
  }
  for (const m of misses.slice(0, 3)) {
    lines.push('Miss: ' + m.symbol + ' ' + m.call + (m.conviction != null ? ' at ' + m.conviction : '') + ' on ' + m.date +
      (m.setup ? ' (' + m.setup + ')' : '') + ' — ' + m.result + (m.shape ? '; ' + m.shape : '') +
      (m.btcPct != null ? '; BTC did ' + (m.btcPct > 0 ? '+' : '') + m.btcPct + '% meanwhile' : '') +
      (m.claim ? '. You said: "' + m.claim + '"' : '') + '.');
    if (m.postmortem) lines.push('  What actually happened: ' + m.postmortem);
  }
  /*  One line each for the record's two ends, so "what is your best call"
      has an answer — and so the best is never read without the worst.   */
  const endLine = (label, e) => label + ': ' + e.symbol + ' ' + e.call + (e.conviction != null ? ' at ' + e.conviction : '') +
    ' on ' + e.date + (e.setup ? ' (' + e.setup + ')' : '') + ' — ' + (e.pct > 0 ? '+' : '') + e.pct + '% at ' + e.mark + 'h' +
    (e.netOf === 'btc' ? ', ' + (e.net > 0 ? '+' : '') + e.net + '% net of BTC' : '') + '.';
  if (extremes.best.length && extremes.worst.length) {
    lines.push(endLine('Your best call, net of the market, across every coin', extremes.best[0]));
    lines.push(endLine('Your worst', extremes.worst[0]));
  }

  return {
    asOf: new Date(now).toISOString(),
    calls: all.length, graded: graded.length, settled: settled.length, settledAt24: settledAt24.length,
    window: DIGEST_WINDOW, minForRate: MIN_FOR_DIGEST, deadbandPct: DEADBAND_PCT,
    marks, overall, vsMarket, marketOnly, byCall, byConviction, bySetup, byMark, hedging,
    onThisCoin, recentMisses: misses, recentHits: hits,
    bestCalls: extremes.best, worstCalls: extremes.worst, rankedCalls: extremes.ranked,
    text: lines.join('\n'),
    note: 'Your own past calls, checked against what price then did — each at the checkpoint its own horizon named, ' +
          'and again net of BTC over the same window. A rate needs ' + MIN_FOR_DIGEST + ' decided calls; under that it is ' +
          'withheld. Weigh this, let it temper conviction where you have been running hot — it is a pattern to notice, ' +
          'never a reason to call something the data in front of you does not show, and never a reason to call neutral.',
  };
}
/*  The clock the record runs on. The analyst writes `generatedAt` itself,
    and it guesses: two thirds of the reports on this machine were stamped
    1–14 hours off the moment the file was actually written, mostly ahead.
    Every checkpoint is timed from that stamp, so a call stamped 13h in the
    future takes its entry price from the wrong bar and settles 13h late.
    The file's write time is the true time of the call — the session writes
    it as its last act — so that wins when the two disagree by more than
    ten minutes. Once only (the marker says so), and never across a gap of
    a day or more: that is a file copied or checked out, not written, and
    then the stamp inside it is the better witness. Pure; returns what the
    report should be and whether it changed.                              */
const SCORE_STAMP_SLACK_MS = 10 * 60e3;
const SCORE_STAMP_MAX_MS = 24 * HOUR;
function scoreStampTime(report, writtenAtMs) {
  if (!report || typeof report !== 'object' || report.generatedAtStamped) return { report, changed: false };
  if (!Number.isFinite(writtenAtMs)) return { report, changed: false };
  const said = Date.parse(report.generatedAt);
  const off = Number.isFinite(said) ? writtenAtMs - said : Infinity;
  if (Number.isFinite(said) && Math.abs(off) <= SCORE_STAMP_SLACK_MS) return { report, changed: false };
  if (Number.isFinite(said) && Math.abs(off) >= SCORE_STAMP_MAX_MS) return { report, changed: false };
  const fixed = Object.assign({}, report, {
    generatedAt: new Date(writtenAtMs).toISOString(),
    generatedAtModel: Number.isFinite(said) ? report.generatedAt : null,
    generatedAtStamped: true,
  });
  return { report: fixed, changed: true };
}
/* ==SCORE_END== */

/* ---------- plumbing ---------- */

function listReportFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir || VERDICTS); } catch (e) { return []; }
  return names.filter(n =>
    n.endsWith('.json') && n !== 'latest.json' && n !== 'example.json' && !n.startsWith('.'));
}

function readReport(name, dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir || VERDICTS, name), 'utf8')); }
  catch (e) { return null; }
}

function trackPath(which, dir) {
  return path.join(dir || VERDICTS, '.track-record-' + which + '.json');
}

// `dir` is for tests and for an engine pointed somewhere else; the default is the repo's verdicts/
function readTrack(which, dir) {
  try { return JSON.parse(fs.readFileSync(trackPath(which, dir), 'utf8')); }
  catch (e) { return []; }
}

function writeTrack(which, records, dir) {
  fs.mkdirSync(dir || VERDICTS, { recursive: true });
  fs.writeFileSync(trackPath(which, dir), JSON.stringify(records, null, 2));
}

function upsert(records, id, seed) {
  let r = records.find(x => x.id === id);
  if (!r) { r = Object.assign({ id, checks: {} }, seed); records.push(r); }
  return r;
}

function dueSoon(record, now) {
  const generatedAtMs = Date.parse(record.generatedAt);
  if (!Number.isFinite(generatedAtMs)) return false;
  return SCORE_CHECKS.some(h => !record.checks[String(h)] && generatedAtMs + h * HOUR <= now);
}

/*  The analyst sides a report can carry, each with its own record file.
    A report from before the crowd analyst existed simply has no crowd
    block, and gets no crowd record — nothing is invented for it.       */
const SCORE_SIDES = ['stoch', 'news', 'crowd'];

/*  Settles every report that has a due, unsettled checkpoint on any side.
    Fetches bars at most once per report (shared between the sides' records,
    since it is the same coin's price either way) and only when something
    is actually due — a quiet pass costs one directory read and no network
    calls at all.                                                        */
async function settleAll(engine, opts) {
  let restamped = 0, retimed = 0;
  const o = opts || {};
  const now = o.now || Date.now();
  const dir = o.dir;
  const tracks = {};
  for (const side of SCORE_SIDES) tracks[side] = readTrack(side, dir);
  let filled = 0, fetched = 0;

  /*  BTC's bars, fetched once per pass and only when something is due, so
      every settled checkpoint can carry the market's move over the same
      window. Wide enough for the oldest report that needs it.           */
  let btcBars, btcTried = false;
  const btcFor = async generatedAtMs => {
    if (btcTried) return btcBars;
    btcTried = true;
    try {
      await engine.ready();
      const g = engine.g;
      const H1 = g.TFS.find(t => t.key === '1H');
      const hoursSpan = Math.ceil((now - generatedAtMs) / HOUR) + 4;
      btcBars = await g.pull(g.symbolOf(BASELINE_SYMBOL), H1, Math.min(Math.max(hoursSpan, 26), 1000));
    } catch (e) { btcBars = null; }      // settle without the baseline rather than not at all
    return btcBars;
  };
  let oldestDue = now;

  for (const name of listReportFiles(dir)) {
    let report = readReport(name, dir);
    if (!report || !report.symbol) continue;
    // the file's write time is the call's true time — see scoreStampTime
    let mtime = NaN;
    try { mtime = fs.statSync(path.join(dir || VERDICTS, name)).mtimeMs; } catch (e) { /* leave it */ }
    const stamped = scoreStampTime(report, mtime);
    if (stamped.changed) {
      report = stamped.report;
      try { fs.writeFileSync(path.join(dir || VERDICTS, name), JSON.stringify(report, null, 2)); } catch (e) { /* the record still moves */ }
      restamped++;
    }
    if (!report.generatedAt) continue;
    const id = name.replace(/\.json$/, '');

    const recs = [];
    for (const side of SCORE_SIDES) {
      const block = report[side];
      if (!block || typeof block !== 'object') continue;
      const rec = upsert(tracks[side], id, Object.assign({
        symbol: report.symbol, generatedAt: report.generatedAt,
        call: block.call, conviction: block.conviction,
      }, scoreDescribe(side, block)));
      // records written before the setup tag or the horizon mark existed pick
      // them up here — the report is already open, and a settled checkpoint
      // is never touched
      if (rec.setup === undefined || rec.mark === undefined) Object.assign(rec, scoreDescribe(side, block));
      recs.push(rec);
    }
    /*  …except when the call's time itself was wrong. A record settled from
        a stamp hours off took its entry price from the wrong bar; those
        checkpoints are not a record of anything. Re-time it and clear them,
        and they settle again, correctly, from this pass on. The post-mortem
        and the record note are the analyst's words and stay.            */
    for (const rec of recs) {
      if (rec.generatedAt !== report.generatedAt) { rec.generatedAt = report.generatedAt; rec.checks = {}; retimed++; }
    }

    const needsBars = recs.some(rec => dueSoon(rec, now));
    if (!needsBars) continue;
    const generatedAtMs = Date.parse(report.generatedAt);
    if (generatedAtMs < oldestDue) oldestDue = generatedAtMs;

    let bars;
    try {
      await engine.ready();
      const g = engine.g;
      const code = String(report.symbol).trim().toUpperCase();
      const meta = g.symbolOf(code);
      const H1 = g.TFS.find(t => t.key === '1H');
      const hoursSpan = Math.ceil((now - generatedAtMs) / HOUR) + 4;
      bars = await g.pull(meta, H1, Math.min(Math.max(hoursSpan, 26), 1000));
      fetched++;
    } catch (e) { continue; }               // try this one again next pass

    const base = await btcFor(oldestDue);
    for (const rec of recs) filled += settleRecord(rec, bars, now, base);
  }

  for (const side of SCORE_SIDES) writeTrack(side, tracks[side], dir);
  return { filled, fetched, restamped, retimed,
           stochCount: tracks.stoch.length, newsCount: tracks.news.length, crowdCount: tracks.crowd.length };
}

/* ---------- CLI ---------- */

const USAGE = `
Odysseus track-record settler

  node mcp/score.js            settle whatever is due, print the digests
  node mcp/score.js --quiet    settle only, no digest printed
`.trim();

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(USAGE + '\n'); return; }
  const quiet = args.includes('--quiet');

  const { Engine } = require('./engine.js');
  const engine = new Engine({});
  const res = await settleAll(engine);
  // the desk's own record, for the next /read to open — written here, after
  // settling, so it is never staler than the records it is built from
  try { require('./history.js').historyWriteDeskBrief(); } catch (e) { process.stderr.write('desk brief: ' + e.message + '\n'); }

  if (!quiet) {
    process.stdout.write(`settled ${res.filled} checkpoint(s), fetched ${res.fetched} symbol(s)\n`);
    process.stdout.write('stochastic — ' + scoreDigest(readTrack('stoch'), 24).text + '\n');
    process.stdout.write('news       — ' + scoreDigest(readTrack('news'), 24).text + '\n');
    process.stdout.write('crowd      — ' + scoreDigest(readTrack('crowd'), 24).text + '\n');
  }
}

if (require.main === module) {
  main().catch(e => { process.stderr.write('FATAL: ' + (e && e.stack || e) + '\n'); process.exit(1); });
}

module.exports = {
  scorePriceAt, scoreCovers, callGrade, settleRecord, scoreDigest,
  scoreExcursion, scoreLiveMark, scoreIsOpen, scoreNextCheck,
  scoreBrief, scoreDescribe, scoreFrameOf, scoreTally, scoreMissShape, scoreHorizonMark, scoreRecordMark, scoreExtremes, scoreStampTime,
  settleAll, readTrack, writeTrack, listReportFiles, readReport,
  SCORE_SIDES, SCORE_CHECKS, DEADBAND_PCT, MIN_FOR_DIGEST, DIGEST_WINDOW, HOUR, BASELINE_SYMBOL, SCORE_HEDGE_MIN, SCORE_HEDGE_PCT, SCORE_EXTREMES, SCORE_STAMP_SLACK_MS, SCORE_STAMP_MAX_MS,
};
