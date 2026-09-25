/* analyst.js — the Analyst view: a read-only inbox for the external two-analyst read.

   This is NOT the agent layer coming back. The app holds no API key, makes no
   model call, has no tools and does no reasoning here. It renders a report that
   something else wrote, the same way it would render a PDF someone sent it. The
   thinking happens outside, in a Claude session talking to mcp/server.js; this
   file is a display surface and a validator, nothing more.

   A report arrives one of three ways:
     - pasted in, or a .json file dropped on the view (works offline, no setup)
     - through the existing cloud sync, under vl.analyst.v1, pushed by
       mcp/publish.js from wherever the analysts ran
     - pulled from the local relay (mcp/panel.js) right after a read the
       buttons in this view asked for — through the same validator as paste

   The buttons do not make the app think. They ask a small relay on this
   machine to run the same commands the launch/ files run, and show its output
   here instead of in a terminal window. The relay has a fixed list of actions
   and no model key; the browser cannot launch Claude Code itself, and that is
   the whole of what the relay adds.

   Everything above the render section is pure and unit-tested.
   part of Odysseus */

/* ==ANALYST_START== */
const ANALYST_KEY    = 'vl.analyst.v1';
const ANALYST_SCHEMA = 'odysseus.analyst.v1';
const ANALYST_MAX    = 50;            // an inbox, not an archive
const ANALYST_STALE_H = 6;            // a structural read older than this is history, not a read

const ANALYST_CALLS      = ['bull', 'bear', 'neutral'];
const ANALYST_AGREEMENTS = ['agree', 'partial', 'clash'];
const ANALYST_DIRECTIONS = ['bull', 'bear', 'neutral', 'split'];

/*  What the calls actually add up to, computed from the calls themselves
    rather than taken on trust from whoever wrote the report. If a reconciler
    claims "agree" over a bull and a bear, the view says so — a summary that
    contradicts its own evidence is the one thing this surface must never pass
    along quietly.

    Three analysts now: stoch, news and crowd. The third argument is optional
    so a report from before the crowd analyst existed (two sides) reads the
    way it always did. Any two directional calls pointing opposite ways is a
    clash; every present call identical is agreement; anything else — a
    neutral among directional calls, or only one side answering — is
    partial.                                                                 */
function analystCallsOf(stochCall, newsCall, crowdCall) {
  return [stochCall, newsCall, crowdCall].filter(c => c !== undefined)
    .map(c => ANALYST_CALLS.includes(c) ? c : null);
}

function analystAgreementOf(stochCall, newsCall, crowdCall) {
  const calls = analystCallsOf(stochCall, newsCall, crowdCall);
  const present = calls.filter(Boolean);
  if (present.length < 2) return 'partial';
  const dir = present.filter(c => c !== 'neutral');
  if (dir.includes('bull') && dir.includes('bear')) return 'clash';
  if (present.length === calls.length && present.every(c => c === present[0])) return 'agree';
  return 'partial';
}

function analystDirectionOf(stochCall, newsCall, crowdCall) {
  const agreement = analystAgreementOf(stochCall, newsCall, crowdCall);
  if (agreement === 'clash') return 'split';
  const dir = analystCallsOf(stochCall, newsCall, crowdCall).filter(c => c === 'bull' || c === 'bear');
  return dir.length ? dir[0] : 'neutral';
}

const ANALYST_AGREEMENT_NOTE = {
  agree:   'Every analyst reached the same call from different evidence. This is the strongest read the system produces.',
  partial: 'Not every analyst has a call — at least one is neutral. Part of the evidence supports it.',
  clash:   'The analysts disagree. The disagreement is the signal — read what each one saw before deciding.',
};

function analystStr(v) { return typeof v === 'string' ? v.trim() : ''; }

function analystList(v) {
  if (!Array.isArray(v)) return [];
  return v.map(x => analystStr(x)).filter(Boolean);
}

function analystNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function analystSide(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const call = analystStr(o.call).toLowerCase();
  return {
    call: ANALYST_CALLS.includes(call) ? call : null,
    conviction: analystNum(o.conviction),
    horizon: analystStr(o.horizon) || null,
    for: analystList(o.for),
    against: analystList(o.against),
    catalyst: o.catalyst && typeof o.catalyst === 'object' ? {
      found: !!o.catalyst.found,
      what: analystStr(o.catalyst.what) || null,
      source: analystStr(o.catalyst.source) || null,
      beforeTheMove: o.catalyst.beforeTheMove == null ? null : !!o.catalyst.beforeTheMove,
    } : null,
    keyNumbers: o.keyNumbers && typeof o.keyNumbers === 'object' ? o.keyNumbers : {},
    // what the analyst said its own track record changed about this call — the
    // visible proof the record was read, not just carried
    recordNote: analystStr(o.recordNote) || null,
  };
}

/*  Turns whatever arrived into the shape the view renders, or explains why it
    cannot. Deliberately strict about the few fields the view depends on and
    forgiving about everything else: a report from a slightly newer writer
    should still display rather than vanish.                                  */
function analystNormalise(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, error: 'that is not a report object' };
  if (analystStr(raw.schema) !== ANALYST_SCHEMA)
    return { ok: false, error: 'wrong schema — expected "' + ANALYST_SCHEMA + '", got "' +
                               (analystStr(raw.schema) || 'nothing') + '"' };

  const symbol = analystStr(raw.symbol).toUpperCase();
  if (!symbol) return { ok: false, error: 'the report names no symbol' };

  const rec = raw.reconciliation && typeof raw.reconciliation === 'object' ? raw.reconciliation : null;
  if (!rec) return { ok: false, error: 'the report has no reconciliation block' };
  const headline = analystStr(rec.headline);
  if (!headline) return { ok: false, error: 'the reconciliation has no headline' };

  const at = Date.parse(raw.generatedAt);
  if (!isFinite(at)) return { ok: false, error: 'generatedAt is not a date I can read' };

  const stoch = analystSide(raw.stoch);
  const news  = analystSide(raw.news);
  // the crowd analyst arrived later: a report without its block has no crowd
  // side at all, which is different from a crowd side that said neutral
  const crowd = raw.crowd && typeof raw.crowd === 'object' ? analystSide(raw.crowd) : null;

  const claimed = analystStr(rec.agreement).toLowerCase();
  const derived = analystAgreementOf(stoch.call, news.call, crowd ? crowd.call : undefined);
  const claimedDir = analystStr(rec.direction).toLowerCase();

  return {
    ok: true,
    report: {
      symbol,
      at,
      generatedAt: raw.generatedAt,
      stoch, news, crowd,
      agreement: ANALYST_AGREEMENTS.includes(claimed) ? claimed : derived,
      derivedAgreement: derived,
      /*  Flagged, not corrected. The view shows both and lets the reader judge;
          silently rewriting someone's summary to match its own arithmetic would
          be its own kind of lie.                                              */
      agreementDisputed: ANALYST_AGREEMENTS.includes(claimed) && claimed !== derived,
      direction: ANALYST_DIRECTIONS.includes(claimedDir) ? claimedDir
                                                         : analystDirectionOf(stoch.call, news.call, crowd ? crowd.call : undefined),
      confidence: analystNum(rec.confidence),
      headline,
      body: analystList(rec.body),
      clashes: analystList(rec.clashes),
      whatWouldChangeIt: analystStr(rec.whatWouldChangeIt) || null,
      recordNote: analystStr(rec.recordNote) || null,
    },
  };
}

function analystParse(text) {
  const s = analystStr(text);
  if (!s) return { ok: false, error: 'nothing to read' };
  let raw;
  try { raw = JSON.parse(s); }
  catch (e) { return { ok: false, error: 'that is not valid JSON (' + e.message + ')' }; }
  return analystNormalise(raw);
}

// one report, or a file holding several
function analystParseMany(text) {
  const s = analystStr(text);
  if (!s) return { ok: false, error: 'nothing to read', reports: [] };
  let raw;
  try { raw = JSON.parse(s); }
  catch (e) { return { ok: false, error: 'that is not valid JSON (' + e.message + ')', reports: [] }; }
  const list = Array.isArray(raw) ? raw : [raw];
  const reports = [], errors = [];
  list.forEach((r, i) => {
    const out = analystNormalise(r);
    if (out.ok) reports.push(out.report);
    else errors.push((list.length > 1 ? '#' + (i + 1) + ': ' : '') + out.error);
  });
  return { ok: reports.length > 0, reports, error: errors.join('; ') || null };
}

/*  Newest first, one report per symbol per timestamp. Re-adding the same file
    twice is a no-op rather than a duplicate, because pasting the same thing
    again is what a person does when they are not sure it worked.            */
function analystMerge(existing, incoming) {
  const seen = new Set();
  const all = [...(incoming || []), ...(existing || [])];
  const out = [];
  for (const r of all) {
    if (!r || !r.symbol) continue;
    const key = r.symbol + '|' + r.at;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, ANALYST_MAX);
}

function analystAgeHours(report, now) {
  return ((now === undefined ? Date.now() : now) - report.at) / 3600e3;
}

function analystStale(report, now) {
  return analystAgeHours(report, now) > ANALYST_STALE_H;
}

/*  "2h ago", "3d ago" — the only thing a trader wants from a timestamp on a
    read that decays.                                                        */
function analystAgeLabel(report, now) {
  const h = analystAgeHours(report, now);
  if (h < 0) return 'just now';
  if (h < 1) return Math.max(1, Math.round(h * 60)) + 'm ago';
  if (h < 48) return Math.round(h) + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

function analystLatestFor(reports, symbol) {
  const sym = analystStr(symbol).toUpperCase();
  return (reports || []).find(r => r.symbol === sym) || null;
}

/*  "Which ones are interesting" — the newest fresh read per coin, ranked.

    The score is the reconciler's confidence scaled by what kind of agreement
    produced it: two independent analysts landing on the same call is worth
    the whole number, one call plus a neutral is worth most of it, and a
    clash is worth half — a clash is the most *interesting* thing the system
    produces but it is not a trade, and this list is for trading. Reports
    with no direction, and stale ones, are left out; a neutral consensus is
    "no trade", so it does not rank either.                                */
const ANALYST_AGREEMENT_WEIGHT = { agree: 1.0, partial: 0.75, clash: 0.5 };

function analystShortlist(reports, now, limit) {
  const t = now === undefined ? Date.now() : now;
  const seen = new Set();
  const out = [];
  for (const r of (reports || []).slice().sort((a, b) => b.at - a.at)) {
    if (!r || !r.symbol || seen.has(r.symbol)) continue;
    seen.add(r.symbol);                                     // newest per coin only
    if (analystStale(r, t)) continue;
    if (!r.direction || r.direction === 'split' || r.direction === 'neutral') continue;
    const w = ANALYST_AGREEMENT_WEIGHT[r.agreement] || 0;
    const conf = r.confidence == null ? 0 : r.confidence;
    out.push({
      symbol: r.symbol, direction: r.direction, agreement: r.agreement,
      confidence: r.confidence, score: Math.round(conf * w), at: r.at, headline: r.headline,
      disputed: !!r.agreementDisputed,
    });
  }
  out.sort((a, b) => b.score - a.score || b.at - a.at);
  return out.slice(0, limit || 8);
}

/* ---------- the history: every call, against what price did after ----------

   Rows come from the relay's /history — mcp/history.js lays each report
   beside the two track records mcp/score.js keeps, and adds a live mark
   for calls still waiting on a checkpoint. The app only filters, tallies
   and words it. The checkpoints are whatever the relay says they are;
   ANALYST_HISTORY_CHECKS is the fallback for a relay that predates them. */
const ANALYST_HISTORY_CHECKS = [24, 48, 72, 168];
const ANALYST_HISTORY_SIDES = [
  { key: 'stoch', label: 'Stoch analyst' },
  { key: 'news',  label: 'News analyst' },
  { key: 'crowd', label: 'Crowd analyst' },
  { key: 'desk',  label: 'The desk' },
];
const ANALYST_HISTORY_SHOW = 12;

function analystHistoryCall(row, side) {
  const s = row && row[side];
  if (!s) return null;
  return side === 'desk' ? s.direction : s.call;
}

/*  Newest first; `only` is all | open | settled; `symbol` narrows to one
    coin (prefix match, so "SO" finds SOL and SONIC); `side` keeps rows
    where that side actually made a directional call.                   */
function analystHistoryFilter(rows, opts) {
  const o = opts || {};
  const sym = analystStr(o.symbol).toUpperCase();
  const only = o.only || 'all';
  let out = (rows || []).filter(r => r && r.symbol);
  if (sym) out = out.filter(r => r.symbol.startsWith(sym));
  if (only === 'open') out = out.filter(r => r.open);
  if (only === 'settled') out = out.filter(r => !r.open);
  if (o.side) out = out.filter(r => { const c = analystHistoryCall(r, o.side); return c === 'bull' || c === 'bear'; });
  return out.slice().sort((a, b) => b.at - a.at || a.symbol.localeCompare(b.symbol));
}

function analystPctLabel(pct, dp) {
  if (pct == null || !isFinite(pct)) return '—';
  const d = dp === undefined ? 1 : dp;
  return (pct > 0 ? '+' : pct < 0 ? '−' : '') + Math.abs(pct).toFixed(d) + '%';
}

/*  Small coins need more digits than big ones; a price is never "0.00". */
function analystPriceLabel(p) {
  if (p == null || !isFinite(p)) return '—';
  const dp = p >= 1000 ? 0 : p >= 100 ? 1 : p >= 1 ? 3 : p >= 0.01 ? 5 : 7;
  const s = Number(p).toFixed(dp);
  return '$' + (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
}

const ANALYST_GRADE_LABEL = { right: '✓ right', wrong: '✗ wrong', flat: '~ flat', pending: '…', expired: 'no data' };
function analystGradeLabel(grade) {
  if (grade === null || grade === undefined) return 'no call';
  return ANALYST_GRADE_LABEL[grade] || String(grade);
}

/*  "in 19h" / "due" / "3h overdue" for the next checkpoint.            */
function analystDueLabel(next, now) {
  if (!next || !isFinite(next.dueAt)) return '';
  const h = (next.dueAt - (now === undefined ? Date.now() : now)) / 3600e3;
  if (h > 1) return 'in ' + Math.round(h) + 'h';
  if (h > 0) return 'in ' + Math.max(1, Math.round(h * 60)) + 'm';
  if (h > -0.5) return 'due now';
  return 'due, settles on the next pass';
}

/*  The words for one row — what each side said, and what price then did.
    Returns lines, plain sentences, so the view can print them and a test
    can read them. `checks` is the relay's list of marks.               */
function analystHistoryStory(row, checks, now) {
  const marks = checks && checks.length ? checks : ANALYST_HISTORY_CHECKS;
  const t = now === undefined ? Date.now() : now;
  const lines = [];
  const who = { stoch: 'Stoch', news: 'News', desk: 'The desk' };
  const said = side => {
    const s = row[side]; const call = analystHistoryCall(row, side);
    if (!s || !call) return who[side] + ' made no call.';
    const conv = analystHistoryConviction(row, side);
    const verb = side === 'desk' ? (call === 'split' ? 'called it split' : 'leaned ' + call) : 'said ' + call;
    return who[side] + ' ' + verb + (conv == null ? '' : ' at ' + Math.round(conv)) +
      (side === 'desk' && s.agreement ? ' (' + s.agreement + ')' : '') +
      (side !== 'desk' && s.horizon ? ', for ' + s.horizon : '') + '.';
  };
  lines.push(said('stoch'));
  lines.push(said('news'));
  lines.push(said('desk'));

  const entry = row.price && row.price.entry;
  if (entry != null) lines.push('Price at the call: ' + analystPriceLabel(entry) + '.');

  for (const h of marks) {
    const c = row.price && row.price.checks && row.price.checks[String(h)];
    if (!c || c.state !== 'settled') continue;
    const ran = c.maxUp != null && c.maxDown != null ? ' — ran ' + analystPctLabel(c.maxUp) + ' / ' + analystPctLabel(c.maxDown) + ' on the way' : '';
    const verdicts = ANALYST_HISTORY_SIDES.map(sd => {
      const g = row[sd.key] && row[sd.key].grades && row[sd.key].grades[String(h)];
      const call = analystHistoryCall(row, sd.key);
      if (!(call === 'bull' || call === 'bear')) return null;
      return who[sd.key].toLowerCase().replace('the desk', 'desk') + ' ' + (g === 'right' ? 'right' : g === 'wrong' ? 'wrong' : g === 'flat' ? 'flat' : '?');
    }).filter(Boolean);
    lines.push('At ' + h + 'h: ' + analystPriceLabel(c.exit) + ' (' + analystPctLabel(c.pct) + ')' + ran +
      (verdicts.length ? ' → ' + verdicts.join(', ') : ' → nothing to grade') + '.');
  }

  if (row.open) {
    const lv = row.live;
    if (lv && lv.pct != null) {
      const sofar = ANALYST_HISTORY_SIDES.map(sd => {
        const g = row[sd.key] && row[sd.key].grades && row[sd.key].grades.live;
        const call = analystHistoryCall(row, sd.key);
        if (!(call === 'bull' || call === 'bear')) return null;
        return who[sd.key].toLowerCase().replace('the desk', 'desk') + ' ' + (g === 'right' ? 'right so far' : g === 'wrong' ? 'wrong so far' : 'flat so far');
      }).filter(Boolean);
      lines.push('Now, ' + lv.hoursIn + 'h in: ' + analystPriceLabel(lv.price) + ' (' + analystPctLabel(lv.pct) + ')' +
        (lv.maxUp != null ? ', peaked ' + analystPctLabel(lv.maxUp) + ', dipped ' + analystPctLabel(lv.maxDown) : '') +
        (sofar.length ? ' → ' + sofar.join(', ') : '') + '.');
    }
    if (row.next) lines.push('Next check: ' + row.next.hours + 'h, ' + analystDueLabel(row.next, t) + '.');
  } else {
    lines.push('Every checkpoint is settled.');
  }
  return lines;
}

/*  A tally cell: "3✓ 1✗ (75%)" with the undecided kept out of the rate. */
function analystTallyLabel(t) {
  if (!t || !t.count) return '—';
  const bits = [];
  if (t.right) bits.push(t.right + '✓');
  if (t.wrong) bits.push(t.wrong + '✗');
  if (t.flat) bits.push(t.flat + '~');
  const rate = t.rate == null ? '' : ' (' + t.rate + '%)';
  const wait = t.pending ? ' · ' + t.pending + ' waiting' : '';
  return (bits.length ? bits.join(' ') : '0 graded') + rate + wait;
}

/*  The same tally the relay keeps per side and mark, split by what the
    side actually called. "60% right" is not a record yet: 60% on bulls and
    a coin flip on bears is a different analyst from the reverse, and only
    this split says which one you have. `call` narrows to bull or bear;
    without it, both — which is the relay's own number, recomputed here so
    the two tables can never disagree.                                    */
function analystHistoryTally(rows, side, mark, call) {
  const t = { count: 0, right: 0, wrong: 0, flat: 0, pending: 0, expired: 0, rate: null };
  for (const r of rows || []) {
    const s = r && r[side];
    if (!s) continue;
    const c = analystHistoryCall(r, side);
    if (!(c === 'bull' || c === 'bear')) continue;
    if (call && c !== call) continue;
    t.count++;
    const g = s.grades && s.grades[String(mark)];
    if (g === 'right') t.right++;
    else if (g === 'wrong') t.wrong++;
    else if (g === 'flat') t.flat++;
    else if (g === 'expired') t.expired++;
    else t.pending++;
  }
  const decided = t.right + t.wrong;
  t.rate = decided ? Math.round(t.right / decided * 100) : null;
  return t;
}

/*  Which way a side leans: how many bull, bear and neutral (or split)
    calls it has made, and the bull share of the directional ones.      */
function analystHistoryLean(rows, side) {
  const n = { bull: 0, bear: 0, other: 0, none: 0, bullPct: null };
  for (const r of rows || []) {
    const c = analystHistoryCall(r, side);
    if (c === 'bull') n.bull++;
    else if (c === 'bear') n.bear++;
    else if (c) n.other++;
    else n.none++;
  }
  const dir = n.bull + n.bear;
  n.bullPct = dir ? Math.round(n.bull / dir * 100) : null;
  return n;
}

const ANALYST_LEAN_MIN = 5;   // fewer directional calls than this and "leans" is noise
function analystLeanLabel(n) {
  if (!n || !(n.bull + n.bear + n.other)) return 'no calls yet';
  const bits = [n.bull + ' bull', n.bear + ' bear'];
  if (n.other) bits.push(n.other + ' neutral');
  let lean = '';
  if (n.bullPct != null && n.bull + n.bear >= ANALYST_LEAN_MIN)
    lean = n.bullPct >= 65 ? ' — leans bull' : n.bullPct <= 35 ? ' — leans bear' : ' — even-handed';
  return bits.join(' · ') + lean;
}

/*  For a collapsed history row: each side's call and its latest verdict —
    the last settled mark, or "so far" while the call is still open.    */
function analystHistoryStrip(row, checks) {
  const marks = (checks && checks.length ? checks : ANALYST_HISTORY_CHECKS).map(String);
  return ANALYST_HISTORY_SIDES.map(sd => {
    const s = row && row[sd.key];
    const call = analystHistoryCall(row, sd.key);
    const out = { side: sd.key, call: call || null, grade: null, mark: null };
    if (!s || !(call === 'bull' || call === 'bear')) return out;
    for (const h of marks) {
      const g = s.grades && s.grades[h];
      if (g === 'right' || g === 'wrong' || g === 'flat') { out.grade = g; out.mark = h + 'h'; }
    }
    if (out.grade == null && row.open && s.grades && s.grades.live) { out.grade = s.grades.live; out.mark = 'so far'; }
    return out;
  });
}

/*  The confidence a side put on its call — conviction for the two analysts,
    confidence for the desk. One place for the field-name difference so
    calibration and the story don't each carry their own copy of it.     */
function analystHistoryConviction(row, side) {
  const s = row && row[side];
  return s ? (side === 'desk' ? s.confidence : s.conviction) : null;
}

/*  Win rate answers "was it right"; this answers "did it matter" — a call
    right by 0.4% past the deadband and one right by 9% both count as one
    win. `pct` is direction-adjusted (a bear call's fall reads as positive)
    so "right" always averages positive and "wrong" always averages
    negative, and the two numbers can sit side by side as one plain
    sentence: this many points to bank against that many to lose.        */
function analystHistoryMagnitude(rows, side, mark, call) {
  const out = { nRight: 0, nWrong: 0, avgRight: null, avgWrong: null };
  let sumRight = 0, sumWrong = 0;
  for (const r of rows || []) {
    const s = r && r[side];
    if (!s) continue;
    const c = analystHistoryCall(r, side);
    if (!(c === 'bull' || c === 'bear')) continue;
    if (call && c !== call) continue;
    const g = s.grades && s.grades[String(mark)];
    if (g !== 'right' && g !== 'wrong') continue;
    const chk = mark === 'live' ? r.live : (r.price && r.price.checks && r.price.checks[String(mark)]);
    const pct = chk && isFinite(chk.pct) ? chk.pct : null;
    if (pct == null) continue;
    const directional = c === 'bear' ? -pct : pct;
    if (g === 'right') { out.nRight++; sumRight += directional; }
    else { out.nWrong++; sumWrong += directional; }
  }
  if (out.nRight) out.avgRight = +(sumRight / out.nRight).toFixed(2);
  if (out.nWrong) out.avgWrong = +(sumWrong / out.nWrong).toFixed(2);
  return out;
}

/*  Confidence bands — coarse on purpose. With a few hundred calls at most,
    anything finer is noise with a decimal point.                        */
const ANALYST_CONV_BANDS = [
  { lo: 0,  hi: 39,  label: '<40' },
  { lo: 40, hi: 59,  label: '40–59' },
  { lo: 60, hi: 79,  label: '60–79' },
  { lo: 80, hi: 100, label: '80+' },
];
function analystConvBand(conv) {
  if (conv == null || !isFinite(conv)) return null;
  const b = ANALYST_CONV_BANDS.find(b => conv >= b.lo && conv <= b.hi);
  return b ? b.label : null;
}

/*  Does the confidence number mean anything? For each row this takes the
    same "best known verdict" the collapsed strip already shows — the last
    settled mark, or the live read while still open — so calibration is
    never out of step with what the person can already see on the row.
    Bucketed by conviction band; a band with no decided calls yet is left
    out rather than shown as a hollow 0%.                                */
function analystHistoryCalibration(rows, side, checks) {
  const buckets = {};
  for (const r of rows || []) {
    const conv = analystHistoryConviction(r, side);
    const band = analystConvBand(conv);
    if (!band) continue;
    const strip = analystHistoryStrip(r, checks).find(s => s.side === side);
    if (!strip || (strip.grade !== 'right' && strip.grade !== 'wrong')) continue;
    if (!buckets[band]) buckets[band] = { band, count: 0, right: 0, wrong: 0, rate: null };
    buckets[band].count++;
    if (strip.grade === 'right') buckets[band].right++; else buckets[band].wrong++;
  }
  return ANALYST_CONV_BANDS.map(b => buckets[b.label]).filter(Boolean)
    .map(t => { t.rate = Math.round(t.right / t.count * 100); return t; });
}

/*  How fast a call shows its hand: the earliest checkpoint where it first
    reads right or wrong (flat and pending are not an answer yet), split by
    which way it went. Not "when it finally settled" — a call flat at 24h
    and right at 48h shows its hand at 48h, same as one right at 24h and
    still right at 48h shows it at 24h. Answers "how long do I actually
    have to wait to know", which is the sizing/patience question, not the
    settlement bookkeeping question.                                     */
function analystHistorySpeed(rows, side, checks) {
  const marks = (checks && checks.length ? checks : ANALYST_HISTORY_CHECKS).slice().sort((a, b) => a - b);
  const out = { nRight: 0, nWrong: 0, avgRight: null, avgWrong: null };
  let sumRight = 0, sumWrong = 0;
  for (const r of rows || []) {
    const s = r && r[side];
    const call = analystHistoryCall(r, side);
    if (!s || !(call === 'bull' || call === 'bear')) continue;
    for (const h of marks) {
      const g = s.grades && s.grades[String(h)];
      if (g !== 'right' && g !== 'wrong') continue;
      if (g === 'right') { out.nRight++; sumRight += h; } else { out.nWrong++; sumWrong += h; }
      break;   // first decisive mark only
    }
  }
  if (out.nRight) out.avgRight = Math.round(sumRight / out.nRight);
  if (out.nWrong) out.avgWrong = Math.round(sumWrong / out.nWrong);
  return out;
}

/*  The record by combination: what the three of them said together, and
    how that went. "Stoch bull, news bull, desk bull" is one line; "stoch
    bull, news bear, desk bull" is another. Graded on the desk's call,
    because the desk's call is the one there is to trade — the analysts'
    own grades are already in their own tables. A combination whose desk
    call is split or neutral is listed (it happened) but never graded (there
    is nothing to grade). The unanimous ones — all three bull, all three
    bear — are the headline, so they are also rolled up as a pair on top:
    "all three agree" against "not all three", which is the question that
    was actually being asked.                                            */
/*  A row from before the crowd analyst has no crowd side; its combination
    is the old three-way one and its key is unchanged, so old and new rows
    never share a bucket by accident. Unanimous means every analyst that
    answered called the same direction, and the desk went with it.       */
function analystHistoryCombo(row) {
  const s = analystHistoryCall(row, 'stoch') || 'none';
  const n = analystHistoryCall(row, 'news')  || 'none';
  const hasCrowd = !!(row && row.crowd && (row.crowd.call || row.crowd.tracked));
  const c = hasCrowd ? (analystHistoryCall(row, 'crowd') || 'none') : null;
  const d = analystHistoryCall(row, 'desk')  || 'none';
  const unanimous = (s === 'bull' || s === 'bear') && s === n && n === d && (c === null || c === s);
  return { stoch: s, news: n, crowd: c, desk: d,
           key: s + '|' + n + (c === null ? '' : '|' + c) + '|' + d, unanimous,
           label: 'S ' + s + ' · N ' + n + (c === null ? '' : ' · C ' + c) + ' · D ' + d };
}

/*  Every combination that has actually occurred, most common first; ties
    by label so the order is stable between renders.                    */
function analystHistoryCombos(rows) {
  const seen = {};
  for (const r of rows || []) {
    if (!r) continue;
    const c = analystHistoryCombo(r);
    if (!seen[c.key]) seen[c.key] = Object.assign({ n: 0 }, c);
    seen[c.key].n++;
  }
  return Object.values(seen).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

/*  A tally over the rows matching a combination key — or over the
    unanimous rows (`key` === 'unanimous') or everything else with a
    directional desk call ('rest'). Same tally as the main table, filtered.
    `side` defaults to the desk — the call there is to trade — but a
    combination is also asked side by side (see analystHistoryComboSides),
    which is how a clash shows who actually had the direction right.    */
function analystHistoryComboTally(rows, key, mark, side) {
  const pick = (rows || []).filter(r => {
    if (!r) return false;
    const c = analystHistoryCombo(r);
    if (key === 'unanimous') return c.unanimous;
    if (key === 'rest') return !c.unanimous && (c.desk === 'bull' || c.desk === 'bear');
    return c.key === key;
  });
  return analystHistoryTally(pick, side || 'desk', mark);
}

/*  Within one combination every row has the same three calls, so grading
    a side over the combination's rows is one number per side — and sides
    that said the same thing get the same number, since a grade is only the
    call against the price path. So a combination is shown as one line per
    DISTINCT directional call, labelled with who made it: all three bull is
    one line "S+N+D bull"; stoch bull / news bear / desk bull is two, "S+D
    bull" and "N bear", and those two are mirror images — that mirror is
    the answer to "who was right". A side that said neutral or split has no
    line, because it has nothing to grade.                               */
function analystHistoryComboSides(combo) {
  const sides = [['S', 'stoch', combo.stoch], ['N', 'news', combo.news], ['C', 'crowd', combo.crowd], ['D', 'desk', combo.desk]];
  const byCall = {};
  for (const [letter, side, call] of sides) {
    if (!(call === 'bull' || call === 'bear')) continue;
    if (!byCall[call]) byCall[call] = { call, side, letters: [] };
    byCall[call].letters.push(letter);
  }
  return ['bull', 'bear'].filter(c => byCall[c]).map(c => ({
    call: c, side: byCall[c].side, label: byCall[c].letters.join('+') + ' ' + c,
  }));
}
/* ==ANALYST_END== */

/* ---------- state ---------- */
let analystReports = (()=>{
  try {
    const raw = JSON.parse(localStorage.getItem(ANALYST_KEY) || '[]');
    const out = [];
    for (const r of (Array.isArray(raw) ? raw : [])) {
      // stored reports are already normalised, but a hand-edited key should not take the view down
      if (r && r.symbol && isFinite(r.at) && r.headline) out.push(r);
    }
    return out.sort((a, b) => b.at - a.at);
  } catch (e) { return []; }
})();
let analystNote = '';
let analystOpen = null;

function analystSave() { return vlPut(ANALYST_KEY, JSON.stringify(analystReports)); }

function analystAdd(text) {
  const parsed = analystParseMany(text);
  if (!parsed.ok) { analystNote = parsed.error || 'nothing could be read'; renderAnalyst(); return false; }
  const before = analystReports.length;
  analystReports = analystMerge(analystReports, parsed.reports);
  const added = analystReports.length - before;
  analystNote = added
    ? added + ' report' + (added === 1 ? '' : 's') + ' added' + (parsed.error ? ' (' + parsed.error + ')' : '')
    : 'already had that one' + (parsed.error ? ' (' + parsed.error + ')' : '');
  analystSave();
  renderAnalyst();
  return true;
}

function analystRemove(symbol, at) {
  analystReports = analystReports.filter(r => !(r.symbol === symbol && r.at === at));
  analystSave();
  renderAnalyst();
}

function analystClear() {
  analystReports = [];
  analystNote = 'cleared';
  analystSave();
  renderAnalyst();
}

/* ---------- render ---------- */
const ANALYST_CALL_CLS = { bull: 'up', bear: 'down', neutral: 'flat' };

function analystPill(text, cls) {
  return '<span class="anpill ' + cls + '">' + nvEsc(text) + '</span>';
}

function analystSideBlock(title, side, subtitle) {
  if (!side || !side.call) {
    return '<div class="anside"><header><h4>' + nvEsc(title) + '</h4></header>' +
           '<p class="anempty">no call in this report</p></div>';
  }
  let html = '<div class="anside"><header><h4>' + nvEsc(title) + '</h4>' +
             analystPill(side.call, ANALYST_CALL_CLS[side.call] || 'flat') +
             (side.conviction == null ? '' : '<span class="anconv">' + Math.round(side.conviction) + '</span>') +
             '</header>';
  if (subtitle) html += '<p class="ansub">' + nvEsc(subtitle) + '</p>';
  if (side.horizon) html += '<p class="anhorizon">' + nvEsc(side.horizon) + '</p>';
  if (side.recordNote) html += '<p class="anrecord"><b>Own record:</b> ' + nvEsc(side.recordNote) + '</p>';
  if (side.catalyst && side.catalyst.found && side.catalyst.what) {
    html += '<p class="ancat"><b>Catalyst:</b> ' + nvEsc(side.catalyst.what) +
            (side.catalyst.beforeTheMove === false ? ' <em>(published after the move — reporting, not cause)</em>' : '') +
            (side.catalyst.source ? ' <a href="' + nvEsc(side.catalyst.source) +
             '" target="_blank" rel="noopener">source</a>' : '') + '</p>';
  }
  if (side.for.length)
    html += '<ul class="anfor">' + side.for.map(x => '<li>' + nvEsc(x) + '</li>').join('') + '</ul>';
  if (side.against.length)
    html += '<ul class="anagainst">' + side.against.map(x => '<li>' + nvEsc(x) + '</li>').join('') + '</ul>';
  html += '</div>';
  return html;
}

function analystCard(r, now) {
  const stale = analystStale(r, now);
  const open = analystOpen === r.symbol + '|' + r.at;
  const id = r.symbol + '|' + r.at;
  let html = '<article class="ancard' + (stale ? ' stale' : '') + (open ? ' open' : ' closed') + '">';

  /*  Collapsed, a card is its header and its headline — the coin, what the
      two sides agreed, which way, how sure, how old — and nothing else.
      Pressing the header opens the rest. The two sides' full cases, the
      clash, the body, the record notes: all of that is a read, not a
      glance, and a page of glances is what the inbox is for.           */
  html += '<header class="anhead" data-an-toggle="' + nvEsc(id) + '" title="' + (open ? 'less' : 'more') + '">' +
    '<div class="anid">' + nvIcon(r.symbol) + '<b>' + nvEsc(r.symbol) + '</b>' +
    analystPill(r.agreement, r.agreement) +
    (r.direction && r.direction !== 'split'
      ? analystPill(r.direction, ANALYST_CALL_CLS[r.direction] || 'flat')
      : r.direction === 'split' ? analystPill('split', 'clash') : '') +
    '<span class="ancalls" title="stoch · news · crowd">' +
      (r.stoch && r.stoch.call ? analystPill('S ' + r.stoch.call, ANALYST_CALL_CLS[r.stoch.call] || 'flat') : '') +
      (r.news && r.news.call ? analystPill('N ' + r.news.call, ANALYST_CALL_CLS[r.news.call] || 'flat') : '') +
      (r.crowd && r.crowd.call ? analystPill('C ' + r.crowd.call, ANALYST_CALL_CLS[r.crowd.call] || 'flat') : '') +
    '</span>' +
    '</div>' +
    '<div class="anmeta">' +
    (r.confidence == null ? '' : '<span class="anconf">' + Math.round(r.confidence) + '</span>') +
    '<span class="anage">' + nvEsc(analystAgeLabel(r, now)) + '</span>' +
    '<span class="anchev">' + (open ? '▾' : '▸') + '</span>' +
    '</div></header>';

  html += '<p class="anheadline">' + nvEsc(r.headline) + '</p>';

  if (!open) return html + '</article>';

  if (stale)
    html += '<p class="anstale">Older than ' + ANALYST_STALE_H + ' hours. Structure and positioning ' +
            'move faster than this — read it as a record of what was true then, not as a call now.</p>';

  if (r.agreementDisputed)
    html += '<p class="andispute">This report calls itself <b>' + nvEsc(r.agreement) + '</b>, but its ' +
            'analysts said <b>' + nvEsc(r.stoch.call || '—') + '</b>, <b>' + nvEsc(r.news.call || '—') + '</b>' +
            (r.crowd ? ' and <b>' + nvEsc(r.crowd.call || '—') + '</b>' : '') +
            ', which reads as <b>' + nvEsc(r.derivedAgreement) + '</b>. Trust the calls over the summary.</p>';

  html += '<p class="annote">' + nvEsc(ANALYST_AGREEMENT_NOTE[r.agreement] || '') + '</p>';
  if (r.recordNote) html += '<p class="anrecord"><b>The desk\'s own record:</b> ' + nvEsc(r.recordNote) + '</p>';

  html += '<div class="ansides' + (r.crowd ? ' three' : '') + '">' +
    analystSideBlock('Stochastic analyst', r.stoch, 'indicator and historical record only') +
    analystSideBlock('News analyst', r.news, 'structure, positioning and headlines only') +
    (r.crowd ? analystSideBlock('Crowd analyst', r.crowd, 'funding, open interest and accounts long only') : '') +
    '</div>';

  if (r.clashes.length)
    html += '<div class="anclash"><h4>Where they disagree</h4><ul>' +
            r.clashes.map(x => '<li>' + nvEsc(x) + '</li>').join('') + '</ul></div>';

  if (r.body.length)
    html += '<div class="anbody">' + r.body.map(p => '<p>' + nvEsc(p) + '</p>').join('') + '</div>';
  if (r.whatWouldChangeIt)
    html += '<p class="anflip"><b>What would change it:</b> ' + nvEsc(r.whatWouldChangeIt) + '</p>';

  html += '<footer class="anfoot">' +
    '<button class="ghost" data-an-toggle="' + nvEsc(id) + '">Less</button>' +
    // only a directional call is a trade to log against — a split or neutral
    // read has nothing for jFindSourceReport's own filter to attach either
    ((r.direction === 'bull' || r.direction === 'bear')
      ? '<button class="ghost" data-an-log="' + nvEsc(r.symbol + '|' + r.at) + '">Log this trade</button>'
      : '') +
    '<button class="ghost" data-an-drop="' + nvEsc(r.symbol + '|' + r.at) + '">Remove</button>' +
    '<span class="anwhen">' + nvEsc(new Date(r.at).toLocaleString()) + '</span>' +
    '</footer></article>';

  return html;
}

function renderAnalyst() {
  const host = $('anrows');
  if (!host) return;
  const now = Date.now();

  const note = $('annote');
  if (note) note.textContent = analystNote;

  const count = $('analyst-count');
  if (count) count.textContent = String(analystReports.length);

  if (!analystReports.length) {
    host.innerHTML =
      '<div class="loading">No analyst reports yet. Press <b>Read this coin</b> above (with the relay ' +
      'running), or paste a report below or drop its .json file here.</div>';
    return;
  }

  const short = analystShortlist(analystReports, now);
  const shortHtml = short.length
    ? '<section class="anshort"><header><h4>Worth a look</h4>' +
      '<span>fresh reads with a direction, ranked by confidence and how the analysts agreed</span></header>' +
      '<ol>' + short.map(s =>
        '<li data-an-jump="' + nvEsc(s.symbol + '|' + s.at) + '">' +
        '<span class="anrank">' + s.score + '</span>' +
        nvIcon(s.symbol) + '<b>' + nvEsc(s.symbol) + '</b>' +
        analystPill(s.direction, ANALYST_CALL_CLS[s.direction] || 'flat') +
        analystPill(s.agreement, s.agreement) +
        (s.disputed ? analystPill('disputed', 'clash') : '') +
        '<span class="anshead">' + nvEsc(s.headline) + '</span>' +
        '<span class="anage">' + nvEsc(analystAgeLabel({ at: s.at }, now)) + '</span>' +
        '</li>').join('') + '</ol></section>'
    : '';

  host.innerHTML = shortHtml + analystReports.map(r => analystCard(r, now)).join('');
  if (typeof renderBtcAnalyst === 'function') renderBtcAnalyst(true);

  host.querySelectorAll('[data-an-jump]').forEach(li => {
    li.onclick = () => {
      analystOpen = li.getAttribute('data-an-jump');
      renderAnalyst();
      const cards = Array.from($('anrows').querySelectorAll('.ancard'));
      const idx = analystReports.findIndex(r => r.symbol + '|' + r.at === analystOpen);
      if (cards[idx]) cards[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });

  host.querySelectorAll('[data-an-toggle]').forEach(b => {
    b.onclick = () => {
      const id = b.getAttribute('data-an-toggle');
      analystOpen = analystOpen === id ? null : id;
      renderAnalyst();
    };
  });
  host.querySelectorAll('[data-an-drop]').forEach(b => {
    b.onclick = () => {
      const [sym, at] = b.getAttribute('data-an-drop').split('|');
      analystRemove(sym, +at);
    };
  });
  // the one link between the analyst view and the journal — opens the log
  // form with this call pre-attached, a plain snapshot (see jFindSourceReport
  // in journal.js), never a second reasoning pathway into either analyst
  host.querySelectorAll('[data-an-log]').forEach(b => {
    b.onclick = () => {
      const [sym, atStr] = b.getAttribute('data-an-log').split('|');
      const at = +atStr;
      const r = analystReports.find(x => x.symbol === sym && x.at === at);
      if (!r) return;
      jOpenForm({
        symbol: sym,
        direction: r.direction === 'bear' ? 'short' : 'long',
        sourceReport: {at: r.at, symbol: r.symbol, direction: r.direction, agreement: r.agreement,
                       confidence: r.confidence, headline: r.headline}
      });
      setView('journal');
    };
  });
}

/* ---------- the relay: buttons for the read that runs outside ---------- */

const ANALYST_RELAY_KEY = 'vl.analyst.relay.v1';   // per machine, on purpose — not a CLOUD_KEY
const ANALYST_RELAY_DEFAULT = 'http://127.0.0.1:8790';

let analystRelay = (()=>{
  try {
    const saved = JSON.parse(localStorage.getItem(ANALYST_RELAY_KEY) || '{}');
    return { url: saved.url || ANALYST_RELAY_DEFAULT, token: saved.token || '' };
  } catch (e) { return { url: ANALYST_RELAY_DEFAULT, token: '' }; }
})();

const anRelay = {
  online: false, status: null, err: '',
  lines: [], logNext: 0, jobStart: null, jobEnded: null,
  seenUntil: null, timer: null, busy: false,
  chat: [], chatNext: 0, chatSessions: {}, to: 'stoch',
  // the history pane: the relay's rows, when they were fetched, and the view's own filters
  hist: null, histAt: 0, histErr: '', hSym: '', hOnly: 'all', hOpen: {}, hAll: false,
};
const ANALYST_HISTORY_EVERY_MS = 60000;   // a poll, not a stream: the marks move hourly

const ANALYST_ASK_HINT = {
  stoch: 'Ask about setups, crosses, grades and what a setup has done before. It cannot see news, positioning or the web — ask the others for that.',
  news:  'Ask about moves, catalysts and what the web says. It cannot see the indicator or the crowd read — ask the others for that.',
  crowd: 'Ask about funding, open interest, who is crowded and which way it unwinds. It cannot see the indicator, headlines or the web — ask the others for that.',
  desk:  'The reconciler: it can dispatch all three blind analysts, weigh them against each other, and write a full report that lands as a card below.',
};
const ANALYST_ASK_PLACEHOLDER = {
  stoch: 'e.g. what does the 1D setup on SUI look like, and how has that setup done before?',
  news:  'e.g. why did ZEC move today — is there a catalyst, or is it the board?',
  crowd: 'e.g. are longs crowded on HYPE right now, and what has happened the last few times they were?',
  desk:  'e.g. give me a full read on LINK · which of today\'s flagged coins is the cleanest long?',
};

function analystRelaySave() {
  try { localStorage.setItem(ANALYST_RELAY_KEY, JSON.stringify(analystRelay)); } catch (e) { /* fine */ }
}

async function analystRelayCall(pathname, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (analystRelay.token) headers['X-Odysseus-Token'] = analystRelay.token;
  const r = await fetch(analystRelay.url.replace(/\/$/, '') + pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const j = await r.json().catch(() => ({ ok: false, error: 'the relay sent something that is not JSON' }));
  if (!r.ok || j.ok === false) throw new Error(j.error || ('relay answered ' + r.status));
  return j;
}

/*  One poll. Cheap when idle (one small GET), a little busier while a job is
    running so the log pane keeps up. Skipped entirely while the view is hidden.
    A finished read is pulled straight into the inbox — through analystAdd, so
    it gets exactly the validation a pasted report gets.                    */
// the history has its own view now, fed by this same poll — so the poll runs
// while either is showing, and stays idle when neither is
function analystRelayWanted() {
  const a = $('analystview'), h = $('anhistview'), b = $('btcview');
  return !!((a && !a.hidden) || (h && !h.hidden) || (b && !b.hidden));
}

async function analystRelayTick() {
  if (!analystRelayWanted() || anRelay.busy) return;
  anRelay.busy = true;
  try {
    const st = await analystRelayCall('/status');
    anRelay.online = true; anRelay.status = st; anRelay.err = '';

    const j = st.job;
    if (j && j.startedAt !== anRelay.jobStart) {          // a new job: start the pane fresh
      anRelay.jobStart = j.startedAt;
      anRelay.lines = [];
    }
    if (st.logNext !== anRelay.logNext) {
      const lg = await analystRelayCall('/log?since=' + anRelay.logNext);
      anRelay.lines = anRelay.lines.concat(lg.lines).slice(-400);
      anRelay.logNext = lg.next;
    }
    if (st.chatNext !== anRelay.chatNext) {
      const ch = await analystRelayCall('/chat?since=' + anRelay.chatNext);
      if (ch.next < anRelay.chatNext || anRelay.chatNext === 0) anRelay.chat = [];   // a reset, or first load
      anRelay.chat = anRelay.chat.concat(ch.messages).slice(-200);
      anRelay.chatNext = ch.next;
    }
    anRelay.chatSessions = st.chatSessions || {};

    /*  Any report that appeared on disk since the last look comes in — from a
        button here, from the hourly task, from a launcher, from the chat. It
        does not matter who wrote it: while this view is open and the relay is
        up, the inbox tracks the folder. Every one still goes through
        analystAdd, so it gets exactly the validation a pasted file gets.
        A running job is left alone until it finishes, so a half-written pass
        does not arrive one coin at a time out of order.                   */
    if (!(j && j.running)) {
      if (anRelay.seenUntil == null)
        anRelay.seenUntil = analystReports.length ? Math.max(...analystReports.map(r => r.at)) : 0;
      const rep = await analystRelayCall('/reports?since=' + (anRelay.seenUntil + 1));
      if (rep.reports && rep.reports.length) {
        analystAdd(JSON.stringify(rep.reports));
        anRelay.seenUntil = Math.max(anRelay.seenUntil,
          ...rep.reports.map(r => Date.parse(r.generatedAt)).filter(Number.isFinite));
      }
    }

    /*  The history: refreshed on a slow clock, and right after any job ends
        (a read adds a row, a settle fills a checkpoint). The live marks in
        it cost the relay a bar fetch per open coin, which it caches — so
        polling this faster would not make the numbers move any sooner.  */
    const ended = j && !j.running ? j.endedAt : null;
    const jobJustEnded = ended != null && ended !== anRelay.jobEnded;
    if (!(j && j.running) && (jobJustEnded || !anRelay.hist || Date.now() - anRelay.histAt > ANALYST_HISTORY_EVERY_MS)) {
      try {
        const h = await analystRelayCall('/history?live=1&limit=2000');
        anRelay.hist = h; anRelay.histErr = '';
      } catch (e) { anRelay.histErr = e.message; }
      anRelay.histAt = Date.now();
      anRelay.jobEnded = ended;
      renderAnalystHistory();
    }
  } catch (e) {
    anRelay.online = false; anRelay.status = null;
    anRelay.err = e.message;
  }
  anRelay.busy = false;
  renderAnalystRelay();
}

function analystChip(text, cls) {
  return '<span class="anchip ' + (cls || '') + '">' + nvEsc(text) + '</span>';
}

function renderAnalystRelay() {
  const strip = $('an-strip');
  if (!strip) return;
  const st = anRelay.status;
  const running = !!(st && st.job && st.job.running);

  if (!anRelay.online || !st) {
    strip.innerHTML = analystChip('relay offline', 'off') +
      '<span class="anhint">Double-click <code>launch\\11 - Relay always on</code> once on this machine and it starts by itself ' +
      'from then on, no window; or <code>launch\\10</code> for just this session. (' + nvEsc(anRelay.err || 'not reachable') + ')</span>';
  } else {
    const w = st.watcher && st.watcher.registered;
    strip.innerHTML =
      analystChip('relay on', 'on') +
      analystChip(st.claude && st.claude.found ? 'claude ok' : 'claude missing', st.claude && st.claude.found ? 'on' : 'off') +
      analystChip(st.credentials ? 'cloud login saved' : 'no cloud login', st.credentials ? 'on' : 'warn') +
      analystChip(w === true ? 'auto: on, every ' + ((st.watcher && st.watcher.everyMin) || 30) + ' min'
                  : w === false ? 'auto: off' : 'auto: n/a', w === true ? 'on' : 'warn') +
      analystChip((st.watchlist || []).length + ' coins', '') +
      (running ? analystChip('running: ' + ((st.actions || {})[st.job.action] || {}).label +
                             (st.job.symbol ? ' ' + st.job.symbol : ''), 'busy') : '');
    if (st.trackRecord) {
      strip.innerHTML += '<div class="antrack"><span><b>stoch record</b> ' + nvEsc(st.trackRecord.stoch) + '</span>' +
                         '<span><b>news record</b> ' + nvEsc(st.trackRecord.news) + '</span>' +
                         (st.trackRecord.crowd ? '<span><b>crowd record</b> ' + nvEsc(st.trackRecord.crowd) + '</span>' : '') + '</div>';
    }
    /*  What the last scan found — the answer to "what is worth reading now".
        A dry run produces no report on purpose (it spends nothing), so this
        list IS its output: every flagged coin, most happened first, with
        the reason, and whether it was read, is waiting, or was skipped.   */
    const lp = st.lastPass;
    if (lp && lp.at) {
      const readOk = (lp.read || []).filter(r => r.ok).map(r => r.sym);
      const failed = (lp.read || []).filter(r => !r.ok).map(r => r.sym);
      const skipped = lp.skipped || [];
      const flagged = lp.flagged || [];
      const shown = anRelay.showAll ? flagged : flagged.slice(0, 10);
      const stateOf = sym => readOk.includes(sym) ? ['read', 'read'] :
                             failed.includes(sym) ? ['failed', 'failed'] :
                             skipped.includes(sym) ? ['next pass', 'skipped'] :
                             lp.dryRun ? ['not read (dry run)', 'dry'] : ['', ''];
      let html = '<div class="anlastpass"><div class="anlphead"><b>Last scan</b> ' +
        nvEsc(analystAgeLabel({ at: lp.at }, Date.now())) +
        ' · ' + nvEsc(String(lp.scanned == null ? '?' : lp.scanned)) + ' coins (' + nvEsc(lp.scope || '') + ')' +
        ' · <b>' + flagged.length + ' flagged</b>' +
        (lp.dryRun ? ' · dry run, nothing read — press <b>Run the analyst</b> to read the top ' + (lp.budget || '') :
                     ' · read ' + readOk.length + (skipped.length ? ', ' + skipped.length + ' waiting for next pass' : '')) +
        '</div>';
      if (flagged.length) {
        html += '<ol class="anlplist">' + shown.map(f => {
          const [label, cls] = stateOf(f.sym);
          return '<li class="' + cls + '" data-an-sym="' + nvEsc(f.sym) + '">' +
            '<span class="anrank">' + (f.standing ? '↻' : (f.score || 0)) + '</span>' +
            '<b>' + nvEsc(f.sym) + '</b>' +
            (label ? '<span class="anlpstate">' + nvEsc(label) + '</span>' : '') +
            '<span class="anlpwhy">' + nvEsc(f.why || '') + '</span></li>';
        }).join('') + '</ol>';
        if (flagged.length > 10)
          html += '<button class="ghost anlpmore" id="an-lp-more">' +
                  (anRelay.showAll ? 'show fewer' : 'show all ' + flagged.length) + '</button>';
      } else {
        html += '<p class="anhint">Nothing crossed a threshold. That is the gate working, not a fault.</p>';
      }
      strip.innerHTML += html + '</div>';
      const more = $('an-lp-more');
      if (more) more.onclick = () => { anRelay.showAll = !anRelay.showAll; renderAnalystRelay(); };
      // click a flagged coin to drop its ticker into the "Read this coin" box
      strip.querySelectorAll('[data-an-sym]').forEach(li => {
        li.onclick = () => { const s = $('an-sym'); if (s) { s.value = li.getAttribute('data-an-sym'); s.focus(); } };
      });
    }
  }

  const logEl = $('an-log');
  if (logEl) {
    logEl.textContent = anRelay.lines.join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  }

  ['an-dry', 'an-pass', 'an-read', 'an-publish', 'an-wstart', 'an-wstop', 'an-send', 'an-chat-new'].forEach(id => {
    const b = $(id);
    if (b) b.disabled = !anRelay.online || running;
  });
  renderAnalystChat(running && st && st.job && st.job.action === 'ask' ? (st.job.to || 'desk') : null);
  renderAnalystHistory();                 // cheap: it redraws only when something it shows has changed
  if (typeof renderBtcAnalyst === 'function') renderBtcAnalyst();   // the Bitcoin desk's card, same rule
  const stop = $('an-stop');
  if (stop) stop.hidden = !running;
}

/*  The conversation. Both sides are rendered as text — the analyst's reply
    is what a model outside the app wrote, shown the way a pasted report is:
    escaped, never interpreted.                                             */
const ANALYST_WHO = { stoch: 'stoch', news: 'news', crowd: 'crowd', desk: 'desk' };

function renderAnalystChat(thinkingTo) {
  const host = $('an-msgs');
  if (!host) return;
  const to = anRelay.to;
  const stuck = host.scrollHeight - host.scrollTop - host.clientHeight < 40;
  const thread = anRelay.chat.filter(m => (m.to || 'desk') === to);
  let html = thread.map(m =>
    '<div class="anmsg ' + (m.role === 'you' ? 'you' : 'them') + (m.error ? ' err' : '') + '">' +
    '<span class="anwho">' + (m.role === 'you' ? 'you' : ANALYST_WHO[to] || 'analyst') + '</span>' +
    '<div class="antext">' + nvEsc(m.text).replace(/\n/g, '<br>') + '</div>' +
    (m.cost != null ? '<span class="ancost">$' + Number(m.cost).toFixed(4) + '</span>' : '') +
    '</div>').join('');
  if (thinkingTo === to)
    html += '<div class="anmsg them thinking"><span class="anwho">' + (ANALYST_WHO[to] || 'analyst') + '</span><div class="antext">' +
            (to === 'desk' ? 'working — dispatching the analysts if the question needs a read…' : 'reading its data…') + '</div></div>';
  else if (thinkingTo)
    html += '<p class="anhint">The ' + nvEsc(ANALYST_WHO[thinkingTo] || 'desk') + ' is answering another thread; one at a time.</p>';
  if (!html) html = '<p class="anhint">Nothing asked here yet. Each of the three remembers its own conversation until you start it over.</p>';
  host.innerHTML = html;
  if (stuck || thinkingTo) host.scrollTop = host.scrollHeight;

  const note = $('an-whom-note');
  if (note) note.textContent = ANALYST_ASK_HINT[to] || '';
  const q = $('an-q');
  if (q) q.placeholder = ANALYST_ASK_PLACEHOLDER[to] || '';
  document.querySelectorAll('[data-an-to]').forEach(b => b.classList.toggle('on', b.getAttribute('data-an-to') === to));
}

/* ---------- the history pane ---------- */

function analystHistoryCell(grade, call) {
  if (!(call === 'bull' || call === 'bear')) return '<td class="anh-nocall" title="a neutral or split call is never right or wrong">—</td>';
  const cls = grade === 'right' ? 'right' : grade === 'wrong' ? 'wrong' : grade === 'flat' ? 'flat' : grade === 'expired' ? 'expired' : 'pending';
  return '<td class="anh-' + cls + '">' + nvEsc(analystGradeLabel(grade)) + '</td>';
}

/*  The "so far" cell: only an open call has a live verdict. A settled one
    has its marks; a call with no live price yet is waiting, not absent. */
function analystHistoryLiveGradeCell(row, side) {
  const call = analystHistoryCall(row, side);
  if (!(call === 'bull' || call === 'bear')) return '<td class="anh-nocall">—</td>';
  if (!row.open) return '<td class="anh-nocall" title="settled — see the marks">—</td>';
  const g = row[side] && row[side].grades && row[side].grades.live;
  if (!row.live || g == null) return '<td class="anh-pending">…</td>';
  return analystHistoryCell(g, call);
}

function analystHistoryPriceCell(c) {
  if (!c || c.state !== 'settled')
    return '<td class="anh-price ' + (c && c.state === 'expired' ? 'expired' : 'pending') + '">' +
           (c && c.state === 'expired' ? 'no data' : '…') + '</td>';
  const dir = c.pct > 0 ? 'up' : c.pct < 0 ? 'down' : '';
  return '<td class="anh-price"><b class="' + dir + '">' + nvEsc(analystPctLabel(c.pct)) + '</b>' +
         '<span class="anh-px">' + nvEsc(analystPriceLabel(c.exit)) + '</span>' +
         (c.maxUp != null ? '<span class="anh-ran" title="how far it ran each way between the call and this mark">↑' +
          nvEsc(analystPctLabel(c.maxUp)) + ' ↓' + nvEsc(analystPctLabel(c.maxDown)) + '</span>' : '') + '</td>';
}

function analystHistoryLiveCell(row) {
  const lv = row.live;
  if (!row.open) return '<td class="anh-price done" title="every checkpoint has settled">settled</td>';
  if (!lv || lv.pct == null) return '<td class="anh-price pending">…</td>';
  const dir = lv.pct > 0 ? 'up' : lv.pct < 0 ? 'down' : '';
  return '<td class="anh-price live"><b class="' + dir + '">' + nvEsc(analystPctLabel(lv.pct)) + '</b>' +
         '<span class="anh-px">' + nvEsc(analystPriceLabel(lv.price)) + '</span>' +
         (lv.maxUp != null ? '<span class="anh-ran" title="peak and trough since the call">↑' +
          nvEsc(analystPctLabel(lv.maxUp)) + ' ↓' + nvEsc(analystPctLabel(lv.maxDown)) + '</span>' : '') + '</td>';
}

function analystHistoryRow(row, checks, now) {
  const open = !!anRelay.hOpen[row.id];
  const marks = checks.map(String);
  let html = '<article class="anhrow' + (row.open ? ' open' : ' done') + (open ? ' expanded' : ' collapsed') + '" data-an-hid="' + nvEsc(row.id) + '">';

  /*  Collapsed, a row is one line: the coin, the desk's read, and each
      side's call with its latest verdict. Pressing it opens the full
      table of marks and the story. The strip is the whole point of the
      collapsed state — enough to scan twenty calls in a glance and see who
      was right, which the table never was.                             */
  const strip = analystHistoryStrip(row, checks);
  const who = { stoch: 'stoch', news: 'news', crowd: 'crowd', desk: 'desk' };
  const stripHtml = '<span class="anhstrip">' + strip.map(s => {
    // a row from before the crowd analyst has no crowd side to show at all
    if (s.side === 'crowd' && !s.call && !(row.crowd && row.crowd.tracked)) return '';
    if (!s.call) return '<span class="anhs nocall">' + who[s.side] + ' —</span>';
    const dirCls = s.call === 'split' ? 'clash' : (ANALYST_CALL_CLS[s.call] || 'flat');
    const g = s.grade === 'right' ? '✓' : s.grade === 'wrong' ? '✗' : s.grade === 'flat' ? '~' : (s.call === 'bull' || s.call === 'bear') ? '…' : '';
    const gCls = s.grade === 'right' ? 'right' : s.grade === 'wrong' ? 'wrong' : s.grade === 'flat' ? 'flat' : 'pending';
    return '<span class="anhs ' + s.side + '" title="' + nvEsc(who[s.side] + ' ' + s.call + (s.mark ? ' — ' + s.grade + ' at ' + s.mark : '')) + '">' +
      who[s.side] + ' <b class="' + dirCls + '">' + nvEsc(s.call) + '</b>' + (g ? ' <i class="' + gCls + '">' + g + '</i>' : '') + '</span>';
  }).join('') + '</span>';

  html += '<header class="anhhead" data-an-htoggle="' + nvEsc(row.id) + '" title="' + (open ? 'less' : 'details') + '">' +
    '<div class="anid">' + nvIcon(row.symbol) + '<b>' + nvEsc(row.symbol) + '</b>' +
    (row.desk.direction ? analystPill(row.desk.direction, row.desk.direction === 'split' ? 'clash' : (ANALYST_CALL_CLS[row.desk.direction] || 'flat')) : '') +
    (row.desk.agreement ? analystPill(row.desk.agreement, row.desk.agreement) : '') +
    stripHtml +
    '</div>' +
    '<div class="anmeta">' +
    (row.price.entry != null ? '<span class="anh-entry" title="price when the call was made">at ' + nvEsc(analystPriceLabel(row.price.entry)) + '</span>' : '') +
    '<span class="anh-state ' + (row.open ? 'open' : 'done') + '">' +
      (row.open ? (row.next ? 'next: ' + row.next.hours + 'h ' + nvEsc(analystDueLabel(row.next, now)) : 'open') : 'settled') + '</span>' +
    '<span class="anage" title="' + nvEsc(new Date(row.at).toLocaleString()) + '">' + nvEsc(analystAgeLabel({ at: row.at }, now)) + '</span>' +
    '<span class="anchev">' + (open ? '▾' : '▸') + '</span>' +
    '</div></header>';

  if (!open) return html + '</article>';

  html += '<div class="anhscroll"><table class="anhtable"><thead><tr><th></th><th>call</th><th>so far</th>' +
    marks.map(h => '<th>' + h + 'h</th>').join('') + '</tr></thead><tbody>';
  html += '<tr class="anh-pricerow"><th>price</th><td class="anh-call">' +
    (row.price.entry != null ? nvEsc(analystPriceLabel(row.price.entry)) : '—') + '</td>' +
    analystHistoryLiveCell(row) + marks.map(h => analystHistoryPriceCell(row.price.checks[h])).join('') + '</tr>';
  for (const sd of ANALYST_HISTORY_SIDES) {
    const s = row[sd.key];
    const call = analystHistoryCall(row, sd.key);
    const conv = sd.key === 'desk' ? s.confidence : s.conviction;
    html += '<tr><th>' + nvEsc(sd.label) + '</th><td class="anh-call">' +
      (call ? analystPill(call, call === 'split' ? 'clash' : (ANALYST_CALL_CLS[call] || 'flat')) : '<span class="anh-nocall">no call</span>') +
      (conv == null ? '' : '<span class="anconv">' + Math.round(conv) + '</span>') + '</td>' +
      analystHistoryLiveGradeCell(row, sd.key) +
      marks.map(h => analystHistoryCell(s.grades && s.grades[h], call)).join('') + '</tr>';
  }
  html += '</tbody></table></div>';

  {
    html += '<div class="anhdetail">';
    if (row.desk.headline) html += '<p class="anh-headline">' + nvEsc(row.desk.headline) + '</p>';
    html += '<div class="anh-sides">';
    html += '<div><h5>Stoch analyst</h5>' +
      (row.stoch.horizon ? '<p><b>Horizon:</b> ' + nvEsc(row.stoch.horizon) + '</p>' : '') +
      (row.stoch.bestSetup ? '<p><b>Setup it leaned on:</b> ' + nvEsc(row.stoch.bestSetup) + (row.stoch.hitRate ? ' — ' + nvEsc(row.stoch.hitRate) : '') + '</p>' : '') +
      (!row.stoch.tracked ? '<p class="anhint">not in the track record (the report predates scoring, or has not been settled yet)</p>' : '') + '</div>';
    html += '<div><h5>News analyst</h5>' +
      (row.news.horizon ? '<p><b>Horizon:</b> ' + nvEsc(row.news.horizon) + '</p>' : '') +
      (row.news.movePct != null ? '<p><b>Move it was reading:</b> ' + nvEsc(analystPctLabel(row.news.movePct)) + (row.news.classification ? ' (' + nvEsc(row.news.classification) + ')' : '') + '</p>' : '') +
      (row.news.catalyst ? '<p><b>Catalyst:</b> ' + nvEsc(row.news.catalyst) + (row.news.catalystBefore === false ? ' <em>(reported after the move)</em>' : '') + '</p>' : '') +
      (!row.news.tracked ? '<p class="anhint">not in the track record yet</p>' : '') + '</div>';
    if (row.crowd && (row.crowd.call || row.crowd.tracked))
      html += '<div><h5>Crowd analyst</h5>' +
        (row.crowd.horizon ? '<p><b>Horizon:</b> ' + nvEsc(row.crowd.horizon) + '</p>' : '') +
        (row.crowd.crowdTag ? '<p><b>Crowd it was reading:</b> ' + nvEsc(row.crowd.crowdTag) + (row.crowd.crowdedSide ? ' (' + nvEsc(row.crowd.crowdedSide) + 's crowded)' : '') + '</p>' : '') +
        (!row.crowd.tracked ? '<p class="anhint">not in the track record yet</p>' : '') + '</div>';
    html += '</div>';
    html += '<ul class="anh-story">' + analystHistoryStory(row, checks, now).map(l => '<li>' + nvEsc(l) + '</li>').join('') + '</ul>';
    html += '</div>';
  }

  html += '<footer class="anfoot"><button class="ghost" data-an-htoggle="' + nvEsc(row.id) + '">Less</button>' +
    '<button class="ghost" data-an-hjump="' + nvEsc(row.symbol + '|' + row.at) + '" title="open this report\'s card below">Report</button>' +
    '<span class="anwhen">' + nvEsc(new Date(row.at).toLocaleString()) + '</span></footer>';
  return html + '</article>';
}

function renderAnalystHistory() {
  const host = $('an-hrows'), sum = $('an-hsum'), note = $('an-hnote');
  if (!host) return;
  const now = Date.now();
  const h = anRelay.hist;
  const sig = JSON.stringify([anRelay.online, anRelay.histAt, anRelay.histErr, anRelay.hSym, anRelay.hOnly,
                              Object.keys(anRelay.hOpen).filter(k => anRelay.hOpen[k]), anRelay.hAll, Math.floor(now / 60000)]);
  if (sig === anRelay.hSig) return;                 // nothing changed — leave the DOM alone
  anRelay.hSig = sig;

  if (!anRelay.online) {
    if (sum) sum.innerHTML = '';
    if (note) note.textContent = '';
    host.innerHTML = '<div class="loading">The history is read through the relay. <code>launch\\11 - Relay always on</code> (once) or <code>launch\\10</code> (this session), and it appears here.</div>';
    return;
  }
  if (!h || !h.rows) {
    if (sum) sum.innerHTML = '';
    if (note) note.textContent = anRelay.histErr ? 'could not load the history: ' + anRelay.histErr : '';
    host.innerHTML = '<div class="loading">' + (anRelay.histErr
      ? 'The relay answered, but not with a history. It may be running an older panel.js — restart it (<code>launch\\12</code> then <code>launch\\11</code>, or close and reopen the <code>launch\\10</code> window).'
      : 'Loading the history…') + '</div>';
    return;
  }

  const checks = (h.checks && h.checks.length ? h.checks : ANALYST_HISTORY_CHECKS);
  const rows = analystHistoryFilter(h.rows, { symbol: anRelay.hSym, only: anRelay.hOnly });
  const openCount = h.rows.filter(r => r.open).length;

  if (sum) {
    /*  One table, three groups. Each side gets its overall line and then
        the same line split by what it called — bull and bear — under a
        heading that says how it leans. A 60% that is 80% on bulls and 40%
        on bears is the thing worth knowing, and it only shows up split.
        The two analysts are what the record is about; the desk's group is
        there, muted, because it is the third call-maker, not the point. */
    const marks = ['live'].concat(checks.map(String));
    const cell = t => {
      const cls = t && t.rate != null ? (t.rate >= 60 ? 'good' : t.rate < 45 ? 'bad' : '') : '';
      return '<td class="' + cls + '">' + nvEsc(analystTallyLabel(t)) + '</td>';
    };
    const line = (label, cls, call, side) =>
      '<tr class="' + cls + '"><th>' + nvEsc(label) + '</th>' +
      marks.map(m => cell(analystHistoryTally(h.rows, side, m, call))).join('') + '</tr>';
    // right count/wrong count answers "how often"; this answers "how much" —
    // the average points banked on a right call against the average points
    // given back on a wrong one, direction-adjusted so both read plainly
    const magCell = m => '<td class="anh-mag">' +
      (m.avgRight != null || m.avgWrong != null
        ? nvEsc(analystPctLabel(m.avgRight)) + ' / ' + nvEsc(analystPctLabel(m.avgWrong))
        : '—') + '</td>';
    const magLine = (cls, side) => '<tr class="' + cls + '"><th>avg move (right / wrong)</th>' +
      marks.map(m => magCell(analystHistoryMagnitude(h.rows, side, m, null))).join('') + '</tr>';
    const group = sd => {
      const lean = analystHistoryLean(h.rows, sd.key);
      const deskCls = sd.key === 'desk' ? ' anh-deskgrp' : '';
      return '<tr class="anh-group' + deskCls + '"><th colspan="' + (marks.length + 1) + '">' +
        nvEsc(sd.label) + '<span class="anh-lean">' + nvEsc(analystLeanLabel(lean)) + '</span></th></tr>' +
        line('all calls', 'anh-all' + deskCls, null, sd.key) +
        magLine('anh-mag-row' + deskCls, sd.key) +
        line('bull', 'anh-split' + deskCls, 'bull', sd.key) +
        line('bear', 'anh-split' + deskCls, 'bear', sd.key);
    };
    // confidence calibration and speed-to-a-decisive-read, stoch and news
    // only — the desk's number is a reconciliation, not a forecast with a
    // confidence dial worth calibrating the same way
    const calibSpeed = sd => {
      const calib = analystHistoryCalibration(h.rows, sd.key, checks);
      const speed = analystHistorySpeed(h.rows, sd.key, checks);
      const calibText = calib.length
        ? calib.map(c => c.band + ' → ' + c.rate + '% right (' + c.count + ')').join(' · ')
        : 'not enough decided calls yet to say';
      const speedText = (speed.nRight || speed.nWrong)
        ? 'right calls show it in ~' + (speed.avgRight != null ? speed.avgRight + 'h' : '—') + ' on average (n=' + speed.nRight + '); ' +
          'wrong calls show it in ~' + (speed.avgWrong != null ? speed.avgWrong + 'h' : '—') + ' (n=' + speed.nWrong + ')'
        : 'not enough decided calls yet to say';
      return '<div class="anhcalib"><b>' + nvEsc(sd.label) + '</b> by confidence: ' + nvEsc(calibText) + '. ' +
        '<b>First decisive read:</b> ' + nvEsc(speedText) + '.</div>';
    };
    // what the three said together, graded on the desk's call — the
    // unanimous pair on top, then every combination that has occurred
    const combos = analystHistoryCombos(h.rows);
    const comboLine = (label, key, cls, n, side) =>
      '<tr class="' + cls + '"><th>' + nvEsc(label) + (n != null ? '<span class="anh-n">' + n + '</span>' : '') + '</th>' +
      marks.map(m => cell(analystHistoryComboTally(h.rows, key, m, side))).join('') + '</tr>';
    // one combination: a heading naming what the three said, then a line
    // per distinct directional call — a clash becomes two mirror lines, and
    // the mirror is what says which analyst had the direction right
    const comboGroup = c => {
      const lines = analystHistoryComboSides(c);
      return '<tr class="anh-cgroup' + (c.unanimous ? ' anh-unan' : '') + '"><th colspan="' + (marks.length + 1) + '">' +
        nvEsc(c.label) + '<span class="anh-n">' + c.n + '</span>' +
        (!lines.length ? '<span class="anh-lean">nothing directional to grade</span>' : '') + '</th></tr>' +
        lines.map(l => comboLine(l.label, c.key, 'anh-split', null, l.side)).join('');
    };
    const comboHtml = combos.length
      ? '<div class="anhscroll"><table class="anhsumtable anhcombo"><thead><tr><th>by combination</th><th>so far</th>' +
        checks.map(c => '<th>' + c + 'h</th>').join('') + '</tr></thead><tbody>' +
        comboLine('everyone agrees', 'unanimous', 'anh-all', combos.filter(c => c.unanimous).reduce((s, c) => s + c.n, 0)) +
        comboLine('not everyone (desk\'s pick)', 'rest', 'anh-all', combos.filter(c => !c.unanimous && (c.desk === 'bull' || c.desk === 'bear')).reduce((s, c) => s + c.n, 0)) +
        combos.map(comboGroup).join('') +
        '</tbody></table></div>'
      : '';
    sum.innerHTML = '<div class="anhscroll"><table class="anhsumtable"><thead><tr><th></th><th>so far</th>' +
      checks.map(c => '<th>' + c + 'h</th>').join('') + '</tr></thead><tbody>' +
      ANALYST_HISTORY_SIDES.map(group).join('') + '</tbody></table></div>' +
      ANALYST_HISTORY_SIDES.filter(sd => sd.key !== 'desk').map(calibSpeed).join('') +
      comboHtml +
      '<p class="anhint">✓ right and ✗ wrong need a move past ' + nvEsc(String(h.deadband != null ? h.deadband : 0.5)) +
      '% in the call\'s direction; smaller is ~ flat. Neutral and split calls are never graded. ' +
      '"So far" is the live price against still-open calls; the hour marks are settled once, from closed bars, and never rewritten. ' +
      '"Leans" needs ' + ANALYST_LEAN_MIN + ' directional calls to say anything. "First decisive read" is the earliest mark a call ' +
      'reads right or wrong, not when every mark is finally settled. Under each combination there is one line per direction called, ' +
      'naming who called it (S stoch, N news, C crowd, D desk) — in a clash the lines are mirror images, and that mirror is who had the ' +
      'direction right. The two rows on top are graded on the desk\'s pick, the one there was to trade.</p>';
  }
  if (note) {
    note.textContent = h.rows.length + ' call' + (h.rows.length === 1 ? '' : 's') + ', ' + openCount + ' still open' +
      (h.liveAt ? ' · live prices ' + analystAgeLabel({ at: h.liveAt }, now) : '') +
      (h.liveErr ? ' · live prices unavailable: ' + h.liveErr : '');
  }

  if (!rows.length) {
    host.innerHTML = '<div class="loading">' + (h.rows.length ? 'Nothing matches that filter.' :
      'No calls yet. Every read the analysts make lands here, and its checkpoints fill in over the week that follows.') + '</div>';
    return;
  }
  const shown = anRelay.hAll ? rows : rows.slice(0, ANALYST_HISTORY_SHOW);
  host.innerHTML = shown.map(r => analystHistoryRow(r, checks, now)).join('') +
    (rows.length > ANALYST_HISTORY_SHOW
      ? '<button class="ghost anlpmore" id="an-hmore">' + (anRelay.hAll ? 'show fewer' : 'show all ' + rows.length) + '</button>' : '');

  host.querySelectorAll('[data-an-htoggle]').forEach(b => {
    b.onclick = () => { const id = b.getAttribute('data-an-htoggle'); anRelay.hOpen[id] = !anRelay.hOpen[id]; renderAnalystHistory(); };
  });
  host.querySelectorAll('[data-an-hjump]').forEach(b => {
    b.onclick = () => {
      const key = b.getAttribute('data-an-hjump');
      const [sym, at] = key.split('|');
      const idx = analystReports.findIndex(r => r.symbol === sym && String(r.at) === at);
      // the report cards live on the Analyst view; the history is its own view now,
      // so a jump from it changes view (setView renders the cards on the way in)
      const show = () => { if ($('analystview') && $('analystview').hidden) setView('analyst'); else renderAnalyst(); };
      if (idx < 0) { analystNote = 'that report is not in the inbox — add it below, or it arrives on the next poll'; show(); return; }
      analystOpen = key; show();
      const cards = Array.from(($('anrows') || { querySelectorAll: () => [] }).querySelectorAll('.ancard'));
      if (cards[idx]) cards[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });
  const more = $('an-hmore');
  if (more) more.onclick = () => { anRelay.hAll = !anRelay.hAll; renderAnalystHistory(); };
}

function buildAnalystHistoryControls() {
  const sym = $('an-hsym'), only = $('an-honly'), refresh = $('an-hrefresh');
  if (sym) sym.oninput = () => { anRelay.hSym = sym.value.trim(); renderAnalystHistory(); };
  if (only) only.onchange = () => { anRelay.hOnly = only.value; renderAnalystHistory(); };
  if (refresh) refresh.onclick = () => { anRelay.histAt = 0; analystRelayTick(); };
  renderAnalystHistory();
}

function buildAnalystRelayControls() {
  const strip = $('an-strip');
  if (!strip) return;
  buildAnalystHistoryControls();

  const q = $('an-q'), send = $('an-send'), fresh = $('an-chat-new');
  document.querySelectorAll('[data-an-to]').forEach(b => {
    b.onclick = () => { anRelay.to = b.getAttribute('data-an-to'); renderAnalystChat(null); if (q) q.focus(); };
  });
  const ask = async () => {
    const text = q ? q.value.trim() : '';
    if (!text) return;
    try {
      anRelay.lines = [];
      await analystRelayCall('/ask', { question: text, to: anRelay.to });
      if (q) q.value = '';
    } catch (e) { anRelay.lines = ['✖ ' + e.message]; }
    analystRelayTick();
  };
  if (send) send.onclick = ask;
  if (q) q.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } };
  if (fresh) fresh.onclick = async () => {
    try { await analystRelayCall('/chat/reset', { to: anRelay.to }); anRelay.chat = []; anRelay.chatNext = 0; } catch (e) { /* shown by the tick */ }
    analystRelayTick();
  };
  renderAnalystChat(null);

  const urlIn = $('an-relay-url'), tokIn = $('an-relay-token');
  if (urlIn) {
    urlIn.value = analystRelay.url;
    urlIn.onchange = () => { analystRelay.url = urlIn.value.trim() || ANALYST_RELAY_DEFAULT; analystRelaySave(); analystRelayTick(); };
  }
  if (tokIn) {
    tokIn.value = analystRelay.token;
    tokIn.onchange = () => { analystRelay.token = tokIn.value.trim(); analystRelaySave(); analystRelayTick(); };
  }

  const run = (action, symbolFn) => async () => {
    try {
      anRelay.lines = [];
      await analystRelayCall('/run', { action, symbol: symbolFn ? symbolFn() : undefined });
    } catch (e) {
      anRelay.lines = ['✖ ' + e.message];
    }
    analystRelayTick();
  };
  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on('an-dry',     run('dry'));
  on('an-pass',    run('pass'));
  on('an-read',    run('read', () => ($('an-sym') || {}).value));
  on('an-publish', run('publish'));
  on('an-wstart',  run('watch-start'));
  on('an-wstop',   run('watch-stop'));
  on('an-stop',    async () => { try { await analystRelayCall('/stop', {}); } catch (e) { /* shown by the tick */ } analystRelayTick(); });
  const sym = $('an-sym');
  if (sym) sym.onkeydown = e => { if (e.key === 'Enter') run('read', () => sym.value)(); };

  // one poll loop for the life of the page; the tick itself does nothing while the view is hidden
  if (!anRelay.timer) anRelay.timer = setInterval(analystRelayTick, 2500);
  analystRelayTick();
}

function buildAnalystControls() {
  buildAnalystRelayControls();

  const paste = $('an-paste');
  const add = $('an-add');
  const clear = $('an-clear');
  const drop = $('an-drop');
  const file = $('an-file');
  if (!paste || !add) return;

  add.onclick = () => {
    if (analystAdd(paste.value)) paste.value = '';
  };
  if (clear) clear.onclick = () => analystClear();

  const readFile = f => {
    const fr = new FileReader();
    fr.onload = () => analystAdd(String(fr.result || ''));
    fr.onerror = () => { analystNote = 'could not read that file'; renderAnalyst(); };
    fr.readAsText(f);
  };

  if (file) file.onchange = () => {
    const f = file.files && file.files[0];
    if (f) readFile(f);
    file.value = '';
  };

  if (drop) {
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => {
      e.preventDefault();
      drop.classList.remove('over');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readFile(f);
    };
  }
}
