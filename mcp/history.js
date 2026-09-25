#!/usr/bin/env node
/* history.js — every call the analysts ever made, laid against what price did.

   This is the PERSON's view, and only the person's. score.js keeps two
   separate track records so that neither analyst can ever read the other's
   history; this file reads both and puts them side by side, with the desk's
   verdict beside them, because the person who runs the desk is allowed to
   see everything. Nothing here is ever handed to an analyst — the relay
   serves it to the app, and the app renders it. Keep it that way.

   One row per report: what each side said, the price when it said it, the
   price at 24h / 48h / 72h / 168h, how far it ran each way in between, and
   whether each side's call turned out right, wrong or flat at each of those
   marks — plus, while a call is still open, where it stands right now.

   Pure functions above the plumbing line, tested in tests/history.test.js.
   part of Odysseus */

'use strict';

const path = require('path');
const fs = require('fs');
const {
  callGrade, scoreLiveMark, scoreIsOpen, scoreNextCheck, scoreRecordMark,
  listReportFiles, readReport, readTrack, SCORE_CHECKS, DEADBAND_PCT, HOUR, MIN_FOR_DIGEST, DIGEST_WINDOW,
} = require('./score.js');

/* ==HISTORY_START== */
const HISTORY_SIDES = ['stoch', 'news', 'crowd', 'desk'];
const HISTORY_ANALYSTS = ['stoch', 'news', 'crowd'];
/*  Rows come back newest first, and this is the cap. It was 200 — which at
    a hundred reads a day is two days of rows, so nothing the app could see
    was ever old enough to have a 48h mark, and the summary was counted over
    the same two days. The record is the point; the cap is a guard against
    a runaway file, not a window.                                          */
const HISTORY_DEFAULT_LIMIT = 2000;

function historyStr(v) { return typeof v === 'string' ? v.trim() : ''; }
function historyNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/*  The price path is the same whichever record it came from — both sides
    were settled from the same bars at the same moment — so it is lifted
    out once. A checkpoint that is settled on one record and not the other
    (a report with only one side, or a half-finished pass) still shows.  */
function historyPricePath(stochRec, newsRec, crowdRec) {
  const path = { entry: null, checks: {} };
  for (const h of SCORE_CHECKS) {
    const key = String(h);
    const c = (stochRec && stochRec.checks && stochRec.checks[key]) ||
              (newsRec && newsRec.checks && newsRec.checks[key]) ||
              (crowdRec && crowdRec.checks && crowdRec.checks[key]) || null;
    if (!c) { path.checks[key] = { state: 'pending' }; continue; }
    if (c.state === 'expired') { path.checks[key] = { state: 'expired' }; continue; }
    path.checks[key] = {
      state: 'settled',
      pct: historyNum(c.pct),
      exit: historyNum(c.exit),
      maxUp: historyNum(c.maxUp),
      maxDown: historyNum(c.maxDown),
    };
    if (path.entry == null && historyNum(c.entry) != null) path.entry = historyNum(c.entry);
  }
  return path;
}

/*  One side's verdict at every mark. A neutral call, a split desk, or a
    side that made no call has nothing to grade — that is `null`, kept
    apart from a checkpoint that simply has not arrived.                  */
function historySideGrades(call, price, live) {
  const out = {};
  const gradable = call === 'bull' || call === 'bear';
  for (const h of SCORE_CHECKS) {
    const key = String(h);
    const c = price.checks[key];
    if (!c || c.state !== 'settled') out[key] = c && c.state === 'expired' ? 'expired' : 'pending';
    else out[key] = gradable ? callGrade(call, c.pct) : null;
  }
  out.live = live && gradable && live.pct != null ? callGrade(call, live.pct) : null;
  return out;
}

function historySide(raw, rec) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const call = historyStr(o.call).toLowerCase();
  const kn = o.keyNumbers && typeof o.keyNumbers === 'object' ? o.keyNumbers : {};
  return {
    call: ['bull', 'bear', 'neutral'].includes(call) ? call : (rec && rec.call) || null,
    conviction: historyNum(o.conviction) != null ? historyNum(o.conviction) : (rec ? historyNum(rec.conviction) : null),
    horizon: historyStr(o.horizon) || null,
    bestSetup: historyStr(kn.bestSetup) || null,
    hitRate: historyStr(kn.hitRate) || null,
    classification: historyStr(kn.classification) || null,
    movePct: historyNum(kn.movePct),
    catalyst: o.catalyst && typeof o.catalyst === 'object' && o.catalyst.found ? historyStr(o.catalyst.what) || null : null,
    catalystBefore: o.catalyst && typeof o.catalyst === 'object' && o.catalyst.beforeTheMove != null ? !!o.catalyst.beforeTheMove : null,
    crowdTag: historyStr(kn.crowdTag) || null,
    crowdedSide: ['long', 'short'].includes(kn.crowdedSide) ? kn.crowdedSide : null,
    recordNote: historyStr(o.recordNote) || (rec && rec.recordNote) || null,
    mark: rec ? scoreRecordMark(rec) : SCORE_CHECKS[0],     // the checkpoint this side's own horizon named
    tracked: !!rec,
  };
}

/*  One report + its records → one row. `live` is the current mark for
    this symbol's bars, if the caller fetched them; null otherwise. The
    crowd record is the last argument so every older caller still works;
    a report from before the crowd analyst has a crowd side with no call. */
function historyRow(id, report, stochRec, newsRec, now, live, crowdRec) {
  const at = Date.parse(report && report.generatedAt);
  if (!report || !report.symbol || !Number.isFinite(at)) return null;
  const price = historyPricePath(stochRec, newsRec, crowdRec);
  if (live && price.entry == null && historyNum(live.entry) != null) price.entry = historyNum(live.entry);
  const rec = report.reconciliation && typeof report.reconciliation === 'object' ? report.reconciliation : {};
  const direction = historyStr(rec.direction).toLowerCase();
  const stoch = historySide(report.stoch, stochRec);
  const news = historySide(report.news, newsRec);
  const crowd = historySide(report.crowd, crowdRec);
  const desk = {
    direction: ['bull', 'bear', 'neutral', 'split'].includes(direction) ? direction : null,
    agreement: historyStr(rec.agreement).toLowerCase() || null,
    confidence: historyNum(rec.confidence),
    headline: historyStr(rec.headline) || null,
    recordNote: historyStr(rec.recordNote) || null,
    // the desk named no horizon of its own; its call spans the longest of the ones it reconciled
    mark: Math.max(stoch.mark, news.mark, report.crowd ? crowd.mark : 0),
  };
  const probe = stochRec || newsRec || crowdRec || { generatedAt: report.generatedAt, checks: {} };
  const liveMark = live ? Object.assign({}, live) : null;
  if (liveMark) delete liveMark.grade;                         // grades are per side, below
  return {
    id,
    symbol: String(report.symbol).toUpperCase(),
    generatedAt: report.generatedAt,
    at,
    ageH: +((now - at) / HOUR).toFixed(1),
    open: scoreIsOpen(probe),
    next: scoreNextCheck(probe, now),
    price,
    live: liveMark,
    stoch: Object.assign(stoch, { grades: historySideGrades(stoch.call, price, liveMark) }),
    news: Object.assign(news, { grades: historySideGrades(news.call, price, liveMark) }),
    crowd: Object.assign(crowd, { grades: historySideGrades(crowd.call, price, liveMark) }),
    desk: Object.assign(desk, { grades: historySideGrades(desk.direction, price, liveMark) }),
  };
}

/*  Every report, newest first, each with its records found by id. Records
    with no report file any more (a report the person deleted) are dropped
    rather than shown half-empty.                                        */
function historyMerge(reports, stochTrack, newsTrack, now, liveBySymbol, limit, crowdTrack) {
  const sIdx = new Map((stochTrack || []).map(r => [r.id, r]));
  const nIdx = new Map((newsTrack || []).map(r => [r.id, r]));
  const cIdx = new Map((crowdTrack || []).map(r => [r.id, r]));
  const rows = [];
  for (const { id, report } of reports || []) {
    const sym = report && report.symbol ? String(report.symbol).toUpperCase() : null;
    const marks = liveBySymbol && sym ? liveBySymbol[sym] : null;
    const live = marks && typeof marks === 'object' && marks[id] ? marks[id] : null;
    const row = historyRow(id, report, sIdx.get(id) || null, nIdx.get(id) || null, now, live, cIdx.get(id) || null);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => b.at - a.at || a.symbol.localeCompare(b.symbol));
  if (limit === 0) return rows;                        // 0 is "all of it" — the caller trims
  return rows.slice(0, limit || HISTORY_DEFAULT_LIMIT);
}

/*  right / wrong / flat over the rows for one side at one mark ('24', '48',
    ... or 'live'). `ungraded` counts the rows that had a call but no result
    yet; `noCall` the neutral/split ones, which are never a hit or a miss.  */
function historyTally(rows, side, mark) {
  const t = { count: 0, right: 0, wrong: 0, flat: 0, pending: 0, expired: 0, noCall: 0, rate: null };
  for (const r of rows || []) {
    const s = r && r[side];
    if (!s) continue;
    const call = side === 'desk' ? s.direction : s.call;
    const g = s.grades && s.grades[String(mark)];
    if (!(call === 'bull' || call === 'bear')) { t.noCall++; continue; }
    t.count++;
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

function historySummary(rows) {
  const out = {};
  for (const side of HISTORY_SIDES) {
    out[side] = {};
    for (const h of SCORE_CHECKS) out[side][String(h)] = historyTally(rows, side, h);
    out[side].live = historyTally(rows, side, 'live');
  }
  return out;
}

/* ---------- the desk's own record, for the desk ----------

   The reconciler is a third call-maker: when the two sides clash it picks
   one, and when they agree it puts a confidence on it. Nothing graded that
   until history.js did — for the person. This is the same record shaped for
   the desk itself to read before its next reconciliation: how its calls did
   at the mark they were about, split by the kind of agreement it was
   reconciling and, in clashes, by which side it followed — the one thing
   only the desk decides. It is the desk's record only. The analysts never
   see it, and it never names how either analyst did on its own.         */
const HISTORY_BRIEF_MISSES = 4;
const HISTORY_HEDGE_PCT = 60;

function historyDeskTally(rows, markOf) {
  let right = 0, wrong = 0, flat = 0, pending = 0;
  for (const r of rows) {
    const g = r.desk.grades[String(markOf(r))];
    if (g === 'right') right++; else if (g === 'wrong') wrong++; else if (g === 'flat') flat++; else pending++;
  }
  const decided = right + wrong;
  return { n: right + wrong + flat, right, wrong, flat, pending,
           rate: decided >= MIN_FOR_DIGEST ? Math.round(right / decided * 100) : null };
}

function historyDeskGroup(rows, keyFn, order, markOf) {
  const groups = {};
  for (const r of rows) { const k = keyFn(r); if (k != null) (groups[k] = groups[k] || []).push(r); }
  const keys = (order || []).filter(k => groups[k]).concat(Object.keys(groups).filter(k => !(order || []).includes(k)).sort());
  const out = {};
  for (const k of keys) out[k] = historyDeskTally(groups[k], markOf);
  return out;
}

// in a clash, which side the desk went with — the decision that is the desk's alone.
// With three analysts: exactly one of them on the desk's side is "followed <that side>",
// two or more is "both agreed" (the name predates the crowd analyst and the record keeps it).
function historyDeskFollowed(r) {
  const d = r.desk.direction;
  if (!(d === 'bull' || d === 'bear')) return null;
  const with_ = HISTORY_ANALYSTS.filter(side => r[side] && r[side].call === d);
  if (with_.length === 0) return 'neither side';
  if (with_.length === 1) return 'followed ' + with_[0];
  return 'both agreed';
}

function historyDeskBrief(rows, now) {
  const t = now || Date.now();
  const all = (rows || []).filter(r => r && r.desk).slice().sort((a, b) => b.at - a.at);
  const recentAll = all.slice(0, DIGEST_WINDOW);
  const graded = all.filter(r => r.desk.direction === 'bull' || r.desk.direction === 'bear');
  const recent = graded.slice(0, DIGEST_WINDOW);
  const own = r => r.desk.mark;
  const settled = recent.filter(r => ['right', 'wrong', 'flat'].includes(r.desk.grades[String(own(r))]));

  const overall = { own: historyDeskTally(recent, own) };
  for (const h of SCORE_CHECKS) overall[String(h)] = historyDeskTally(recent, () => h);
  const byAgreement = historyDeskGroup(recent, r => r.desk.agreement, ['agree', 'partial', 'clash'], own);
  const inClashes = historyDeskGroup(recent.filter(r => r.desk.agreement === 'clash'), historyDeskFollowed, ['followed stoch', 'followed news', 'followed crowd'], own);
  const byConfidence = historyDeskGroup(recent, r => {
    const c = r.desk.confidence; if (c == null) return null;
    return c >= 70 ? 'high (70+)' : c >= 40 ? 'mid (40-69)' : 'low (<40)';
  }, ['high (70+)', 'mid (40-69)', 'low (<40)'], own);

  const undecidedN = recentAll.filter(r => r.desk.direction === 'split' || r.desk.direction === 'neutral').length;
  const hedging = { undecided: undecidedN, ofLast: recentAll.length,
                    pct: recentAll.length ? Math.round(undecidedN / recentAll.length * 100) : null,
                    warn: recentAll.length >= MIN_FOR_DIGEST && undecidedN / recentAll.length * 100 >= HISTORY_HEDGE_PCT };

  const misses = settled.filter(r => r.desk.grades[String(own(r))] === 'wrong').slice(0, HISTORY_BRIEF_MISSES).map(r => {
    const c = r.price.checks[String(own(r))];
    return { symbol: r.symbol, date: String(r.generatedAt).slice(0, 10), direction: r.desk.direction, confidence: r.desk.confidence,
             agreement: r.desk.agreement, followed: historyDeskFollowed(r), headline: r.desk.headline, mark: own(r),
             pct: c && c.pct != null ? c.pct : null, recordNote: r.desk.recordNote };
  });

  const lines = [];
  const o = overall.own;
  if (!all.length) lines.push('The desk has no track record yet.');
  else if (!settled.length) lines.push('The desk has made ' + all.length + ' call(s); none has reached its checkpoint yet.');
  else {
    lines.push('Your last ' + recent.length + ' directional reconciliation(s), each read at the longer of the two horizons it reconciled: ' +
      o.right + ' right, ' + o.wrong + ' wrong' + (o.flat ? ', ' + o.flat + ' flat' : '') + (o.pending ? ', ' + o.pending + ' still open' : '') +
      (o.rate != null ? ' — ' + o.rate + '% of decided.' : ' — too few decided to call a rate.'));
    const say = (label, g) => {
      const parts = Object.keys(g).filter(k => g[k].rate != null).map(k => k + ' ' + g[k].rate + '% of ' + (g[k].right + g[k].wrong));
      if (parts.length) lines.push(label + ': ' + parts.join('; ') + '.');
    };
    say('By agreement', byAgreement);
    say('In clashes', inClashes);
    say('By your own confidence', byConfidence);
    // in clashes, is one side clearly the better one to follow? Rated sides only, best against worst
    const rated = ['stoch', 'news', 'crowd'].map(side => [side, inClashes['followed ' + side]]).filter(([, g]) => g && g.rate != null);
    if (rated.length >= 2) {
      rated.sort((a, b) => b[1].rate - a[1].rate);
      const [best, worst] = [rated[0], rated[rated.length - 1]];
      if (best[1].rate - worst[1].rate >= 20)
        lines.push('When they clash you have done better following ' + best[0] +
          ' (' + best[1].rate + '% against ' + worst[1].rate + '% following ' + worst[0] + '). Weigh that, then still read why each side said what it said this time.');
    }
  }
  if (hedging.warn)
    lines.push('You have called split or neutral on ' + hedging.undecided + ' of your last ' + hedging.ofLast + '. Neither is ever graded — a clean record made of them says nothing. Call split when the evidence is genuinely split, not to avoid a call.');
  for (const m of misses.slice(0, 3))
    lines.push('Miss: ' + m.symbol + ' ' + m.direction + (m.confidence != null ? ' at ' + m.confidence : '') + ' on ' + m.date +
      ' (' + (m.agreement || '?') + (m.followed && m.agreement === 'clash' ? ', ' + m.followed : '') + ') — ' +
      (m.pct != null ? (m.pct > 0 ? '+' : '') + m.pct + '% at ' + m.mark + 'h' : 'no price kept') +
      (m.headline ? '. You wrote: "' + m.headline + '"' : '') + '.');

  return {
    asOf: new Date(t).toISOString(), calls: all.length, graded: graded.length, settled: settled.length,
    window: DIGEST_WINDOW, minForRate: MIN_FOR_DIGEST,
    overall, byAgreement, inClashes, byConfidence, hedging, recentMisses: misses,
    text: lines.join('\n'),
    note: 'The desk\'s own reconciliations, checked against what price then did. Rates need ' + MIN_FOR_DIGEST +
          ' decided calls. Use it to weigh how you reconcile — which side to lean on in a clash, what confidence has ' +
          'meant — never to hint at either analyst\'s record in its brief, and never as a reason to call split.',
  };
}

function historyDeskBriefMarkdown(brief) {
  return '# The desk\'s own record\n\n' +
    '_Written by `mcp/score.js` after settling, ' + brief.asOf + '. For the reconciler only — never quote it to either analyst._\n\n' +
    brief.text.split('\n').map(l => l ? '- ' + l : l).join('\n') + '\n\n' + brief.note + '\n';
}
/* ==HISTORY_END== */

/* ---------- plumbing ---------- */

const VERDICTS = path.join(__dirname, '..', 'verdicts');

function historyLoadReports(dir) {
  const out = [];
  for (const name of listReportFiles(dir)) {
    const report = readReport(name, dir);
    if (report) out.push({ id: name.replace(/\.json$/, ''), report });
  }
  return out;
}

/*  Rows from disk alone — reports and both records. No network.          */
function historyLoad(now, limit, dir) {
  const t = now || Date.now();
  return historyMerge(historyLoadReports(dir), readTrack('stoch', dir), readTrack('news', dir), t, null, limit, readTrack('crowd', dir));
}

/*  verdicts/.desk-brief.md — the desk's record, written for /read to open.
    Rebuilt whole every time; nothing in it is ever hand-edited.         */
const DESK_BRIEF_FILE = '.desk-brief.md';

function historyWriteDeskBrief(dir, now) {
  const d = dir || VERDICTS;
  const brief = historyDeskBrief(historyLoad(now, null, d), now);
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, DESK_BRIEF_FILE);
  fs.writeFileSync(file, historyDeskBriefMarkdown(brief));
  return { file, brief };
}

/*  Live marks for every open row: one bar fetch per symbol, shared between
    the rows for that symbol, and the mark is computed per row because each
    row has its own call time. Never touches the record files — a live
    reading is not a settlement, and only score.js settles.               */
async function historyLive(engine, rows, now) {
  const t = now || Date.now();
  const bySymbol = {};
  const open = (rows || []).filter(r => r.open);
  if (!open.length) return bySymbol;
  await engine.ready();
  if (typeof engine._universeOnce === 'function') await engine._universeOnce();
  const g = engine.g;
  const H1 = g.TFS.find(x => x.key === '1H');
  const symbols = [...new Set(open.map(r => r.symbol))];
  await Promise.all(symbols.map(async sym => {
    const oldest = Math.min(...open.filter(r => r.symbol === sym).map(r => r.at));
    const span = Math.ceil((t - oldest) / HOUR) + 4;
    let bars;
    try { bars = await g.pull(g.symbolOf(sym), H1, Math.min(Math.max(span, 26), 1000)); }
    catch (e) { return; }
    bySymbol[sym] = {};
    for (const r of open.filter(x => x.symbol === sym)) {
      const mark = scoreLiveMark({ generatedAt: r.generatedAt, call: null }, bars, t);
      if (mark) bySymbol[sym][r.id] = mark;
    }
  }));
  return bySymbol;
}

/* ---------- CLI ---------- */

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('node mcp/history.js [--live] [--json]   every call, with what price did after\n');
    return;
  }
  let rows = historyLoad();
  if (args.includes('--live')) {
    const { Engine } = require('./engine.js');
    const live = await historyLive(new Engine({}), rows, Date.now());
    rows = historyMerge(historyLoadReports(), readTrack('stoch'), readTrack('news'), Date.now(), live, undefined, readTrack('crowd'));
  }
  if (args.includes('--json')) { process.stdout.write(JSON.stringify({ checks: SCORE_CHECKS, rows, summary: historySummary(rows) }, null, 2) + '\n'); return; }
  const pct = v => v == null ? '  —  ' : (v > 0 ? '+' : '') + v.toFixed(1) + '%';
  const g = v => v === 'right' ? 'RIGHT' : v === 'wrong' ? 'wrong' : v === 'flat' ? 'flat' : v === 'pending' ? '...' : v === 'expired' ? 'exp' : '-';
  for (const r of rows) {
    process.stdout.write(`${r.symbol.padEnd(8)} ${r.generatedAt}  ${r.open ? 'open' : 'done'}` +
      (r.live ? `  now ${pct(r.live.pct)} (${r.live.hoursIn}h in)` : '') + '\n');
    for (const side of HISTORY_SIDES) {
      const s = r[side];
      const call = side === 'desk' ? s.direction : s.call;
      process.stdout.write(`   ${side.padEnd(6)} ${String(call || '—').padEnd(8)}` +
        SCORE_CHECKS.map(h => `${h}h ${pct(r.price.checks[String(h)].pct)} ${g(s.grades[String(h)])}`).join('   ') + '\n');
    }
  }
  const sum = historySummary(rows);
  process.stdout.write('\n' + HISTORY_SIDES.map(side => side.padEnd(6) + SCORE_CHECKS.map(h => {
    const t = sum[side][String(h)]; return `${h}h ${t.right}/${t.wrong}${t.rate != null ? ' (' + t.rate + '%)' : ''}`;
  }).join('  ')).join('\n') + '\n');
}

if (require.main === module) {
  main().catch(e => { process.stderr.write('FATAL: ' + (e && e.stack || e) + '\n'); process.exit(1); });
}

module.exports = {
  historyPricePath, historySideGrades, historySide, historyRow, historyMerge, historyTally, historySummary,
  historyLoad, historyLoadReports, historyLive,
  historyDeskBrief, historyDeskFollowed, historyDeskBriefMarkdown, historyWriteDeskBrief, DESK_BRIEF_FILE,
  HISTORY_SIDES, HISTORY_ANALYSTS, HISTORY_DEFAULT_LIMIT, SCORE_CHECKS, DEADBAND_PCT,
};
