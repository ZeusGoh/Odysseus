/* ui-btc.js — the Bitcoin desk: one page, one coin, every read the app has.

   Everything else in Odysseus follows whatever coin is on the symbol bar.
   This page does not: it is BTC, always, because BTC is the reference every
   other read is measured against, and the one coin worth reading on its
   own every day. Nothing here is computed for the first time — the
   stochastic rows are the Terminal's, the positioning is the Crowd
   terminal's, the sessions are the Sessions view's, the analysts are the
   same two blind analysts and the same desk — this page only puts them on
   one screen for one coin, and adds the one read nothing else has: the
   day-of-week backtest (weekday.js).

   The relay keeps BTC read on a clock (mcp/watch.js's standing reads), so
   the analyst card here is never older than a 4H bar while the automatic
   pass is on; the button below it asks for a fresh one on demand.
   part of Odysseus */

const BTC_DAILY_DEPTH = 2600;              // daily bars to page back — Bybit's BTCUSDT perp opens March 2020
const BTC_DAILY_EVERY_MS = 3600e3;         // the table moves once a day; an hourly refresh is plenty
const BTC_POS_EVERY_MS = 90e3;             // positioning, same cadence as the Crowd terminal
const BTC_LIVE_EVERY_MS = 30e3;            // the stochastic rows, on ensureBtc's own clock
const BTC_RECORD_ROWS = 6;                 // recent BTC calls shown under the analysts' record
const BTC_RECORD_MARKS = [24, 72];         // the two marks the record line quotes

const btcState = {
  daily: null, dailyAt: 0, dailyErr: null, dailyLoading: false, stats: null,
  pos: null, posAt: 0, posErr: null, posLoading: false,
  week: 'all',                             // 'all' | 'recent' — which weekday table is showing
  anSig: '', anOpen: false, anBusy: false, anNote: '',
  timer: null,
};

/* ---------- data ---------- */

async function btcLoadDaily(force) {
  if (btcState.dailyLoading) return;
  if (!force && btcState.daily && Date.now() - btcState.dailyAt < BTC_DAILY_EVERY_MS) return;
  btcState.dailyLoading = true;
  try {
    const tf = TFS.find(t => t.key === '1D');
    const bars = await pull(symbolOf(BTC), tf, BTC_DAILY_DEPTH);
    btcState.daily = bars;
    btcState.stats = weekdayStats(bars);
    btcState.dailyAt = Date.now();
    btcState.dailyErr = null;
  } catch (e) {
    btcState.dailyErr = e.message || 'unavailable';
  } finally {
    btcState.dailyLoading = false;
    renderBtcWeekday();
    renderBtcHead();
  }
}

async function btcLoadPositioning(force) {
  if (btcState.posLoading) return;
  if (!force && btcState.pos && Date.now() - btcState.posAt < BTC_POS_EVERY_MS) return;
  btcState.posLoading = true;
  try {
    btcState.pos = await crowdTermFetch(BTC);      // the Crowd terminal's own fetch and read
    btcState.posAt = Date.now();
    btcState.posErr = null;
  } catch (e) {
    btcState.posErr = e.message || 'unavailable';
  } finally {
    btcState.posLoading = false;
    renderBtcPositioning();
    renderBtcHead();
  }
}

/*  Entering the view. The stochastic side is already loaded — btc-reference
    keeps it so — but a forced ensureBtc makes the rows current to the
    minute; the rest is fetched on its own clock.                        */
async function btcShow() {
  renderBtc();
  ensureBtc(true).then(() => { renderBtcStoch(); renderBtcSessions(); renderBtcHead(); });
  btcLoadPositioning();
  btcLoadDaily();
  if (!btcState.timer) btcState.timer = setInterval(() => {
    if (view !== 'btc') return;
    renderBtcStoch(); renderBtcSessions(); renderBtcHead();
    btcLoadPositioning();
    btcLoadDaily();
  }, BTC_LIVE_EVERY_MS);
}

function renderBtc() {
  renderBtcHead();
  renderBtcStoch();
  renderBtcPositioning();
  renderBtcWeekday();
  renderBtcSessions();
  renderBtcAnalyst();
}

/* ---------- the header: five reads, one line each ---------- */

function btcPill(text, cls) { return '<span class="bxpill ' + (cls || '') + '">' + nvEsc(text) + '</span>'; }
function btcSign(v, dp) { return v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(dp == null ? 2 : dp) + '%'; }

function renderBtcHead() {
  const px = $('bx-px');
  if (!px) return;
  const pos = btcState.pos;
  const daily = data[BTC] && data[BTC]['1D'];
  const last = daily && daily[daily.length - 1], prev = daily && daily[daily.length - 2];
  const price = pos ? pos.t.price : last ? last.c : null;
  const chg = pos ? pos.t.chg : (last && prev ? (last.c - prev.c) / prev.c * 100 : null);
  px.textContent = price == null ? '—' : fmtUsd(price);
  px.className = 'px num ' + (chg == null ? '' : chg >= 0 ? 'up' : 'down');
  const ch = $('bx-chg');
  ch.textContent = chg == null ? '' : btcSign(chg) + ' 24h';
  ch.className = 'chg num ' + (chg == null ? '' : chg >= 0 ? 'up' : 'down');

  // stochastic composite
  const st = states[BTC];
  const score = st ? bias(st, WEIGHTS) : null;
  const sTone = score == null ? '' : score > 8 ? 'up' : score < -8 ? 'down' : '';
  const sText = score == null ? 'loading' : Math.abs(score) <= 8 ? 'mixed' : (score > 0 ? 'long' : 'short') + ' ' + (score > 0 ? '+' : '') + score;

  // crowd
  const read = pos && pos.read;
  const cTone = read ? (read.dir === 'bull' ? 'up' : 'down') : '';
  const cText = btcState.posErr && !pos ? 'unavailable' : pos ? (read ? read.tag + ' ' + read.score : 'no crowd read') : 'loading';

  // analysts
  const rep = analystLatestFor(analystReports, BTC);
  const now = Date.now();
  const aTone = rep && rep.direction === 'bull' ? 'up' : rep && rep.direction === 'bear' ? 'down' : '';
  const aText = rep ? (rep.direction || 'split') + ' · ' + rep.agreement + ' · ' + analystAgeLabel(rep, now) : 'no read yet';

  // day of week
  const td = weekdayToday(btcState.stats, now);
  const dTone = td && td.all.lean === 'up' ? 'up' : td && td.all.lean === 'down' ? 'down' : '';
  const dText = td ? td.name + (td.all.n ? ' · ' + btcSign(td.all.avg) + ' avg' : '') : btcState.dailyErr ? 'unavailable' : 'loading';

  // session
  const live = sessionsLive(BTC);
  const sessName = { asia: 'Asia', london: 'London', ny: 'New York' };
  let eText = 'loading', eTone = '';
  if (live) {
    eText = sessName[live.current] || live.current;
    if (live.london && (live.london.breakDir === 'up' || live.london.breakDir === 'down')) {
      eText += ' · London broke ' + live.london.breakDir;
      eTone = live.london.breakDir === 'up' ? 'up' : 'down';
      if (live.ny) eText += live.ny.continued ? ', NY continued' : live.ny.swept ? ', NY swept first' : '';
    } else if (live.asia && live.asia.complete) {
      eText += ' · Asia ' + (live.asia.held === null ? 'done' : live.asia.held ? 'held' : 'broke range');
    }
  }

  $('bx-reads').innerHTML = [
    ['stoch', 'Stochastic', sText, sTone, 'bx-stoch'],
    ['crowd', 'Crowd', cText, cTone, 'bx-pos'],
    ['an', 'Analysts', aText, aTone, 'bx-an'],
    ['day', 'Day', dText, dTone, 'bx-week'],
    ['sess', 'Session', eText, eTone, 'bx-sess'],
  ].map(([k, lab, text, tone, target]) =>
    '<button class="bxread ' + tone + '" data-bx-go="' + target + '"><span class="bxlab">' + lab + '</span>' +
    '<b>' + nvEsc(text) + '</b></button>').join('');
  $('bx-reads').querySelectorAll('[data-bx-go]').forEach(b => {
    b.onclick = () => { const el = $(b.getAttribute('data-bx-go')); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  });
}

/* ---------- stochastic: the Terminal's five frames, read for BTC ---------- */

function renderBtcStoch() {
  const host = $('bx-frames');
  if (!host) return;
  const st = states[BTC], so = stoch[BTC];
  if (!st || !so) { host.innerHTML = '<div class="loading">Loading BTC across the five frames…</div>'; return; }
  delete edgeCache[BTC];                     // fresh candles arrive on ensureBtc's clock

  // the stance strip, the Terminal's own
  const strip = $('bx-strip');
  strip.innerHTML = '';
  TFS.forEach(tf => {
    const v = sideOf(st[tf.key]);
    const col = v > 0.15 ? 'var(--up)' : v < -0.15 ? 'var(--down)' : 'var(--mute)';
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.style.flexGrow = String(tf.weight); seg.style.flexShrink = '1'; seg.style.flexBasis = '0%';
    seg.title = tf.label + ' — ' + (v > 0.15 ? 'bullish' : v < -0.15 ? 'bearish' : 'neutral');
    seg.innerHTML = '<i style="background:' + col + ';opacity:' + (0.10 + Math.min(1, Math.abs(v)) * 0.30) + '"></i>' +
                    '<b style="color:' + col + '">' + tf.key + '</b>';
    strip.appendChild(seg);
  });

  const score = bias(st, WEIGHTS);
  const agreeing = TFS.filter(t => { const v = sideOf(st[t.key]); return score >= 0 ? v > 0 : v < 0; }).length;
  const v = $('bx-verdict');
  v.textContent = Math.abs(score) <= 8 ? 'Composite mixed, no frame majority'
                : 'Composite ' + (score > 0 ? 'long' : 'short') + ', ' + agreeing + ' of 5 frames aligned';
  const sc = $('bx-score');
  sc.textContent = (score > 0 ? '+' : '') + score;
  sc.style.color = score > 8 ? 'var(--up)' : score < -8 ? 'var(--down)' : 'var(--mute)';

  host.innerHTML = TFS.map(tf => {
    const s = st[tf.key], x = so[tf.key];
    const info = { ...SIG[s ? s.type : 'none'] };
    if (s && s.fresh === false) info.color = 'var(--mute)';
    const txt = signalText(tf.key, BTC);
    const k = x && x.k[x.k.length - 1], d = x && x.d[x.d.length - 1];
    const dv = divNow[BTC] && divNow[BTC][tf.key];
    const e = (s && s.level != null && (s.type === 'bull' || s.type === 'bear' || s.pending)) ? edgeFor(BTC, tf.key, s.dir, s.level) : null;
    const age = !s ? '·' : s.pending ? 'live' : (s.type === 'bull' || s.type === 'bear') ? barsTag(s.barsAgo) : '·';
    const lvl = s && s.level != null ? s.level : (k != null ? k : null);
    const tagTone = txt.tag === 'Confirmed' ? 'ok' : txt.tag === 'Stale' ? 'dim' : '';
    const ema = x && x.ema;
    return '<div class="mrow bxrow">' +
      '<div class="tfk">' + tf.key + '</div>' +
      '<div class="sigcell"><div class="sigline">' +
        '<span class="' + (info.ring ? 'ring' : 'dot') + '" style="' + (info.ring ? '' : 'background:' + info.color) + '"></span>' +
        '<span class="stitle">' + txt.title + '</span>' +
        (txt.tag ? '<span class="tag ' + tagTone + '">' + txt.tag + '</span>' : '') +
        '</div><div class="sub">' + txt.sub + '</div>' +
        (e ? '<div class="edge' + (e.thin ? ' thin' : '') + '" title="' + nvEsc(edgeTitle(e)) + '">' + edgeLine(e) + '</div>' : '') +
      '</div>' +
      '<div class="age num">' + age + '</div>' +
      '<div class="kd num">' + (k != null && d != null ? k.toFixed(1) + ' / ' + d.toFixed(1) : '·') + '</div>' +
      '<div class="zone">' + (lvl != null ? '<span class="zpill" style="color:' + zoneTone(lvl) + '">' + zoneTag(lvl) + '</span>' : '<span class="none">·</span>') + '</div>' +
      '<div class="trend">' + (!ema || !ema.ok ? '<span class="tpill">n/a</span>'
        : '<span class="tpill ' + (ema.above ? 'above' : 'below') + '" title="' + (ema.above ? 'above' : 'below') + ' the 200 by ' + Math.abs(ema.dist).toFixed(1) + '%">' + (ema.above ? 'above' : 'below') + '</span>') + '</div>' +
      '<div class="dvg">' + (dv
        ? '<span class="chip" style="color:' + (dv.dir === 'bull' ? 'var(--up)' : 'var(--down)') + ';background:' + (dv.dir === 'bull' ? 'rgba(62,207,142,.10)' : 'rgba(240,97,109,.10)') + '">' +
          (dv.dir === 'bull' ? 'Bull' : 'Bear') + (dv.hidden ? ' hid' : '') + '</span><span class="dmeta num">' + (dv.legs + 1) + 'L ' + (dv.pending ? 'live' : barsTag(dv.barsAgo)) + '</span>'
        : '<span class="none">·</span>') + '</div>' +
      '</div>';
  }).join('');

  // the best live cross, graded against its own record — the verdict engine's word
  const best = bestTrade(BTC);
  const bt = $('bx-best');
  if (!best) bt.innerHTML = '<span class="ctnone">No cross is live on any frame.</span>';
  else bt.innerHTML = '<b class="bxgrade ' + best.grade.replace(/\s+/g, '-') + '">' + nvEsc(best.grade) + '</b> ' +
    '<span>' + nvEsc(best.frame + ' ' + (best.direction || '') + (best.zone ? ' from ' + best.zone : '')) + '</span> — ' +
    '<span class="bxsum">' + nvEsc(best.summary || GRADE_NOTE[best.grade] || '') + '</span>';
}

/* ---------- positioning: the Crowd terminal's read, for BTC ---------- */

function renderBtcPositioning() {
  const rd = $('bx-read');
  if (!rd) return;
  const d = btcState.pos;
  const set = (id, text, cls, title) => { const e = $(id); if (!e) return; e.textContent = text; e.className = 'num ' + (cls || ''); if (title) e.title = title; };
  if (!d) {
    ['bx-fund', 'bx-favg', 'bx-next', 'bx-oi', 'bx-oichg', 'bx-ls', 'bx-oit', 'bx-flow'].forEach(id => set(id, '—'));
    rd.innerHTML = '<h1><span class="ctnone">' + (btcState.posErr ? 'Could not load positioning: ' + nvEsc(btcState.posErr) : 'Reading the last week of BTC positioning…') + '</span></h1>';
    $('bx-cstrip').innerHTML = ''; $('bx-tally').textContent = '';
    return;
  }
  const { t, m, read, flow, series, tally, missing } = d;
  const f = crowdFundingRead(m.fundingPct), r = crowdRatioRead(m.ratio);
  const tone = x => x.side === 'long' ? 'down' : x.side === 'short' ? 'up' : '';
  set('bx-fund', m.fundingPct == null ? '—' : ctPct(m.fundingPct, 3) + ' / 8h', tone(f), m.fundingPct == null ? '' : (m.fundingPct * 3 * 365).toFixed(0) + '% annualised');
  set('bx-favg', m.fundAvgPct == null ? '—' : ctPct(m.fundAvgPct, 3), '', 'mean of the last 8 settlements');
  set('bx-next', ctHours(t.nextFunding), '', t.nextFunding ? new Date(t.nextFunding).toLocaleTimeString() : '');
  set('bx-oi', isFinite(t.oiVal) ? '$' + fmtVol(t.oiVal) : '—', '', isFinite(t.oi) ? t.oi.toLocaleString() + ' contracts' : '');
  set('bx-oichg', ctPct(m.oiChg24) + ' · ' + ctPct(m.oiChg4) + ' 4h', ctTone(m.oiChg24, 3, -3));
  set('bx-ls', m.ratio == null ? '—' : Math.round(m.ratio * 100) + '% long' + (m.ratioAvg != null ? ' · avg ' + Math.round(m.ratioAvg * 100) + '%' : ''), tone(r), 'share of accounts long, and its 24h mean');
  set('bx-oit', m.oiToTurnover == null ? '—' : m.oiToTurnover.toFixed(2) + '×', m.oiToTurnover >= CROWD.overhang ? 'warn' : '', 'open interest ÷ 24h turnover');
  set('bx-flow', flow.tag, flow.cls === 'long' ? 'up' : flow.cls === 'short' ? 'down' : '', flow.why);

  if (read) {
    const col = read.dir === 'bull' ? 'var(--up)' : 'var(--down)';
    rd.innerHTML = '<h1><span style="color:' + col + '">' + read.tag + '</span><span class="num" style="color:' + col + '">' + read.score + '</span>' +
      '<span class="ctlean ' + read.dir + '">lean ' + (read.dir === 'bull' ? 'long' : 'short') + '</span></h1>' +
      '<ul class="ctwhy">' + read.why.map(w => '<li>' + nvEsc(w) + '</li>').join('') + '</ul>';
  } else {
    rd.innerHTML = '<h1><span class="ctnone">No crowd read</span></h1>' +
      '<p class="ctnote">Nothing on BTC is crowded, fresh, squeezed or coiled right now — the numbers are the whole story. A read needs ' + CROWD_MIN_SCORE + ' points.</p>';
  }
  if (missing && missing.length)
    rd.innerHTML += '<p class="ctnote ctmissing">Bybit did not give ' + nvEsc(missing.join('; ')) + ' — the read is made from what it did give.</p>';

  const last = series.slice(-CT_HOURS);
  $('bx-cstrip').innerHTML = last.map(s => {
    const cls = !s.read ? 'none' : s.read.dir;
    const g = s.grade ? ' g-' + s.grade : (s.read ? ' g-open' : '');
    const title = new Date(s.t).toLocaleString() + (s.read ? ' — ' + s.read.tag + ' ' + s.read.score + ' (' + s.read.why[0] + ')' +
      (s.grade ? ' → ' + s.grade + ' at 24h (' + ctPct(s.later) + ')' : ' → still open') : ' — no read');
    return '<i class="' + cls + g + '" title="' + nvEsc(title) + '"></i>';
  }).join('');
  $('bx-tally').textContent = tally.n
    ? 'Last 7 days: a read on ' + tally.n + ' of ' + last.length + ' hours — ' + tally.right + ' right at 24h, ' + tally.wrong + ' wrong' +
      (tally.flat ? ', ' + tally.flat + ' flat' : '') + (tally.open ? ', ' + tally.open + ' still open' : '') +
      (tally.rate != null ? ' → ' + tally.rate + '% of decided' : '') + '. Hours overlap, so read this as recent character, not a sample.'
    : 'Last 7 days: no hour produced a read.';
}

/* ---------- the day of the week ---------- */

function btcDayCell(v, dp, tone) {
  if (v == null) return '<div class="hnum dim">·</div>';
  const cls = tone === false ? '' : v > 0 ? 'up' : v < 0 ? 'down' : 'dim';
  return '<div class="hnum ' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(dp == null ? 2 : dp) + (dp === 0 ? '' : '%') + '</div>';
}

function renderBtcWeekday() {
  const host = $('bx-days');
  if (!host) return;
  const s = btcState.stats;
  const today = $('bx-today');
  if (!s) {
    host.innerHTML = '<div class="loading">' + (btcState.dailyErr ? 'Could not load the daily history: ' + nvEsc(btcState.dailyErr) : 'Paging back through every BTC daily bar Bybit has…') + '</div>';
    today.innerHTML = ''; $('bx-years').innerHTML = ''; $('bx-worst').innerHTML = ''; $('bx-daynote').textContent = '';
    return;
  }
  const now = Date.now();
  const td = weekdayToday(s, now);
  const recent = btcState.week === 'recent';
  const table = recent ? s.recent : s.byDay;
  const base = recent ? s.recentAll : s.all;

  // today's line, the one to read first
  const t = td.all, tr = td.recent;
  const leanWord = l => l === 'up' ? 'leans up' : l === 'down' ? 'leans down' : 'no lean';
  today.innerHTML = '<div class="bxtoday ' + t.lean + '"><span class="bxlab">Today is a UTC ' + td.name + '</span>' +
    '<b>' + leanWord(t.lean) + '</b>' +
    '<span>' + nvEsc(weekdayLabel(t)) + '</span>' +
    (tr && tr.n ? '<span class="bxsub">last 12 months: ' + nvEsc(weekdayLabel(tr)) + ' — ' + leanWord(tr.lean) + '</span>' : '') +
    '</div>';

  $('bx-wk-all').setAttribute('aria-pressed', String(!recent));
  $('bx-wk-recent').setAttribute('aria-pressed', String(recent));

  const order = [1, 2, 3, 4, 5, 6, 0];       // Monday first: the week as a trader sees it
  host.innerHTML = order.map(d => {
    const st = table[d];
    const isToday = d === td.d;
    return '<div class="mrow bxday' + (st.thin ? ' thinsample' : '') + (isToday ? ' today' : '') + ' ' + st.lean + '"' +
      ' title="' + nvEsc(st.t == null ? 'too few days to place against the average' : st.t.toFixed(1) + ' standard errors from the all-days average') + '">' +
      '<div class="bxdayname">' + WEEKDAY_LONG[d] + (isToday ? '<span class="bxnow">today</span>' : '') + '</div>' +
      '<div class="hnum dim">' + st.n + '</div>' +
      btcDayCell(st.avg) + btcDayCell(st.med) +
      '<div>' + (st.win == null ? '<span class="hnum dim">·</span>' : winCell(st.win)) + '</div>' +
      btcDayCell(st.cum, 1) +
      '<div class="hnum ' + (st.huge ? 'down' : 'dim') + '">' + st.huge + '</div>' +
      '<div class="bxlean ' + st.lean + '">' + (st.lean === 'up' ? '▲' : st.lean === 'down' ? '▼' : '·') + '</div>' +
      '</div>';
  }).join('');

  // the year grid: is the day's habit a habit, or one year's accident
  const years = Object.keys(s.byYear).sort();
  $('bx-years').innerHTML = '<div class="bxyhead"><span>Year</span>' + order.map(d => '<span>' + WEEKDAY_NAMES[d] + '</span>').join('') + '</div>' +
    years.map(y => '<div class="bxyrow"><span class="bxyear">' + y + '</span>' +
      order.map(d => { const v = s.byYear[y][d]; return '<span class="hnum ' + (v == null ? 'dim' : v > 0 ? 'up' : v < 0 ? 'down' : 'dim') + '">' + (v == null ? '·' : (v > 0 ? '+' : '') + v.toFixed(2)) + '</span>'; }).join('') +
      '</div>').join('');

  $('bx-worst').innerHTML = s.worst.slice(0, 6).map(w =>
    '<span class="bxworst"><b>' + new Date(w.t).toISOString().slice(0, 10) + '</b> ' + WEEKDAY_NAMES[w.d] + ' <em class="down">' + w.pct.toFixed(1) + '%</em></span>').join('');

  const wd = s.worstDay, bd = s.bestDay;
  $('bx-daynote').textContent =
    (recent ? 'Last ' + base.n + ' closed days' : s.n + ' closed days, ' + new Date(s.from).toISOString().slice(0, 10) + ' to ' + new Date(s.to).toISOString().slice(0, 10)) +
    ', Bybit BTCUSDT perpetual, close to close. All-days average ' + btcSign(base.avg, 3) + ' a day. ' +
    'Worst day by average: ' + WEEKDAY_LONG[wd] + ' (' + btcSign(s.byDay[wd].avg) + '); best: ' + WEEKDAY_LONG[bd] + ' (' + btcSign(s.byDay[bd].avg) + '). ' +
    'Days are UTC days — from 08:00 to 08:00 local on UTC+8. ▲▼ mark a day whose average sits more than one standard error from the rest; ' +
    'that is a lean to trade with, not a rule to trade on. The worst single days fall on every weekday, so this is about grind, not crash risk.';
}

function buildBtcControls() {
  const all = $('bx-wk-all'), rec = $('bx-wk-recent');
  if (all) all.onclick = () => { btcState.week = 'all'; renderBtcWeekday(); };
  if (rec) rec.onclick = () => { btcState.week = 'recent'; renderBtcWeekday(); };
  const rf = $('bx-refresh');
  if (rf) rf.onclick = () => { btcLoadPositioning(true); btcLoadDaily(true); ensureBtc(true).then(renderBtc); };
  const rd = $('bx-read-now');
  if (rd) rd.onclick = btcReadNow;
  const ct = $('bx-open-crowd');
  if (ct) ct.onclick = () => { switchSymbol(BTC); setView('crowdterm'); };
  const tm = $('bx-open-term');
  if (tm) tm.onclick = () => { switchSymbol(BTC); setView('terminal'); };
  document.querySelectorAll('[data-bx-ask]').forEach(b => {
    b.onclick = () => { anRelay.to = b.getAttribute('data-bx-ask'); setView('analyst'); const q = $('an-q'); if (q) { q.value = 'On BTC: '; q.focus(); } };
  });
  const oa = $('bx-open-an');
  if (oa) oa.onclick = () => setView('anhist');
}

/* ---------- sessions: the Sessions view, pinned to BTC ---------- */

function renderBtcSessions() {
  if (!$('bx-sess-live')) return;
  renderSessionsLive(BTC, $('bx-sess-live'));
  renderSessionsStats(BTC, $('bx-sess-stats'), $('bx-sess-sweep'), null);
}

/* ---------- the analysts: the same two, the same desk, on BTC ---------- */

async function btcReadNow() {
  if (btcState.anBusy) return;
  btcState.anBusy = true; btcState.anNote = '';
  renderBtcAnalyst(true);
  try {
    anRelay.lines = [];
    await analystRelayCall('/run', { action: 'read', symbol: BTC });
    btcState.anNote = 'Reading BTC — both analysts, then the desk. A few minutes; the card below updates itself.';
  } catch (e) {
    btcState.anNote = 'Could not start the read: ' + e.message;
  }
  btcState.anBusy = false;
  analystRelayTick();
  renderBtcAnalyst(true);
}

function renderBtcAnalyst(force) {
  const host = $('bx-ancard');
  if (!host) return;
  const now = Date.now();
  const rep = analystLatestFor(analystReports, BTC);
  const st = anRelay.status;
  const running = !!(st && st.job && st.job.running);
  const rows = anRelay.hist ? analystHistoryFilter(anRelay.hist.rows, { symbol: BTC }) : [];
  const btcRows = rows.filter(r => r.symbol === BTC);

  // redraw only when something shown has changed — this runs on the relay's 2.5s poll
  const sig = [anRelay.online, running && st.job.symbol, rep && rep.at, btcState.anOpen, btcState.anBusy, btcState.anNote,
               anRelay.histAt, btcRows.length, st && st.watcher && st.watcher.registered, Math.floor(now / 60000)].join('|');
  if (!force && sig === btcState.anSig) return;
  btcState.anSig = sig;
  renderBtcHead();                           // the Analysts tile up top reads the same report

  // the strip
  const w = st && st.watcher && st.watcher.registered;
  let strip = '';
  if (!anRelay.online) strip = analystChip('relay offline', 'off') + '<span class="anhint">Start it with <code>launch\\11 - Relay always on</code>; the card below is the last read this browser holds.</span>';
  else strip = analystChip('relay on', 'on') +
    analystChip(w === true ? 'BTC re-read every 4h while auto is on' : 'auto off — BTC is read only on demand', w === true ? 'on' : 'warn') +
    (running ? analystChip('running: ' + ((st.actions || {})[st.job.action] || {}).label + (st.job.symbol ? ' ' + st.job.symbol : ''), 'busy') : '') +
    (rep ? analystChip('last BTC read ' + analystAgeLabel(rep, now), analystStale(rep, now) ? 'warn' : '') : analystChip('no BTC read yet', 'warn'));
  $('bx-anstrip').innerHTML = strip;
  const btn = $('bx-read-now');
  if (btn) btn.disabled = !anRelay.online || running || btcState.anBusy;
  $('bx-annote').textContent = btcState.anNote;

  // the card — the inbox's own, opened or closed here without touching the inbox's state
  if (!rep) {
    host.innerHTML = '<div class="loading">No BTC report yet. Press <b>Read BTC now</b> with the relay running, or wait for the next automatic pass.</div>';
  } else {
    const saved = analystOpen;
    analystOpen = btcState.anOpen ? rep.symbol + '|' + rep.at : null;
    host.innerHTML = analystCard(rep, now);
    analystOpen = saved;
    host.querySelectorAll('[data-an-toggle]').forEach(b => { b.onclick = () => { btcState.anOpen = !btcState.anOpen; renderBtcAnalyst(true); }; });
    host.querySelectorAll('[data-an-drop]').forEach(b => { b.onclick = () => { analystRemove(rep.symbol, rep.at); renderBtcAnalyst(true); }; });
    host.querySelectorAll('[data-an-log]').forEach(b => {
      b.onclick = () => {
        jOpenForm({ symbol: BTC, direction: rep.direction === 'bear' ? 'short' : 'long',
          sourceReport: { at: rep.at, symbol: rep.symbol, direction: rep.direction, agreement: rep.agreement, confidence: rep.confidence, headline: rep.headline } });
        setView('journal');
      };
    });
  }

  // the record on this one coin: each side, each mark, and the last few calls
  const rec = $('bx-record');
  if (!btcRows.length) {
    rec.innerHTML = '<div class="loading">' + (anRelay.online ? 'No settled BTC calls in the track record yet.' : 'The track record needs the relay.') + '</div>';
    return;
  }
  const sides = [['stoch', 'Stoch'], ['news', 'News'], ['crowd', 'Crowd'], ['desk', 'Desk']];
  let html = '<div class="bxrechead"><span>Side</span>' + BTC_RECORD_MARKS.map(h => '<span>' + h + 'h</span>').join('') + '<span>Calls</span></div>';
  html += sides.map(([key, lab]) => {
    const lean = analystHistoryLean(btcRows, key);
    return '<div class="bxrecrow"><span class="bxrecside">' + lab + '</span>' +
      BTC_RECORD_MARKS.map(h => {
        const t = analystHistoryTally(btcRows, key, h);
        return '<span class="hnum ' + (t.rate == null ? 'dim' : t.rate >= 55 ? 'up' : t.rate <= 45 ? 'down' : '') + '">' + nvEsc(analystTallyLabel(t)) + '</span>';
      }).join('') +
      '<span class="bxreclean">' + nvEsc(analystLeanLabel(lean)) + '</span></div>';
  }).join('');
  html += '<div class="bxcalls">' + btcRows.slice(0, BTC_RECORD_ROWS).map(r => {
    const strip = analystHistoryStrip(r);
    return '<div class="bxcall"><span class="bxcallwhen">' + nvEsc(String(r.generatedAt).slice(0, 10)) + '</span>' +
      strip.map(x => '<span class="bxcallside" title="' + x.side + '">' + x.side[0].toUpperCase() + ' ' +
        (x.call ? analystPill(x.call, ANALYST_CALL_CLS[x.call] || 'flat') : '<em>—</em>') +
        (x.grade ? '<i class="bxg ' + x.grade + '">' + (x.grade === 'right' ? '✓' : x.grade === 'wrong' ? '✗' : '~') + ' ' + x.mark + '</i>' : '') + '</span>').join('') +
      '</div>';
  }).join('') + '</div>';
  rec.innerHTML = html;
}
